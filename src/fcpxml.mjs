import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assetDescriptor, ensureStillClip, isStillImage } from "./media.mjs";

const DEFAULT_SCHEMA_VERSION = "1.14";

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function gcd(a, b) {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right) [left, right] = [right, left % right];
  return left || 1;
}

export function frameRate(fps) {
  const value = Number(fps);
  const broadcast = [
    [23.976, 1001, 24000],
    [29.97, 1001, 30000],
    [59.94, 1001, 60000]
  ].find(([candidate]) => Math.abs(candidate - value) < 0.01);
  if (broadcast) return { fps: broadcast[0], numerator: broadcast[1], denominator: broadcast[2] };
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid frame rate: ${fps}`);
  const rounded = Math.round(value);
  return { fps: rounded, numerator: 1, denominator: rounded };
}

export function frameCount(seconds, rate) {
  return Math.max(0, Math.round(Number(seconds || 0) * rate.denominator / rate.numerator));
}

export function timeFromFrames(frames, rate) {
  const numerator = frames * rate.numerator;
  const divisor = gcd(numerator, rate.denominator);
  return `${numerator / divisor}/${rate.denominator / divisor}s`;
}

export function time(seconds, rate) {
  return timeFromFrames(frameCount(seconds, rate), rate);
}

function makeSceneRanges(project, duration) {
  const lineRanges = project.timing.lines || [];
  const ranges = project.visuals.map((path, index) => {
    const line = lineRanges[index];
    const fallbackStart = duration * index / project.visuals.length;
    const start = Number(line?.imageStart ?? line?.speechStart ?? line?.start ?? fallbackStart);
    return { path, line, start: Math.max(0, start) };
  });

  ranges.sort((a, b) => a.start - b.start);
  ranges.forEach((range, index) => {
    const next = ranges[index + 1];
    range.end = next ? next.start : duration;
    if (range.end <= range.start) range.end = Math.min(duration, range.start + 1 / Number(project.video.fps || 30));
  });
  return ranges;
}

function sequenceAudioRate(value) {
  const rates = new Map([
    [32000, "32k"],
    [44100, "44.1k"],
    [48000, "48k"],
    [88200, "88.2k"],
    [96000, "96k"],
    [176400, "176.4k"],
    [192000, "192k"]
  ]);
  return rates.get(Number(value)) || "48k";
}

// Audio lengths are expressed over the file's own sample rate, the way Final Cut writes
// them, and always round down. Rounding an asset up to the next video frame would declare
// media that does not exist.
function audioTime(seconds, sampleRate) {
  const samples = Math.max(0, Math.floor(Number(seconds || 0) * sampleRate));
  const divisor = gcd(samples, sampleRate);
  return `${samples / divisor}/${sampleRate / divisor}s`;
}

// How much of an asset an edit may actually use, counted in sequence frames.
function mediaFrames(probe, rate) {
  return Math.floor(Number(probe.duration || 0) * rate.denominator / rate.numerator);
}

function mediaRate(probe, fallback) {
  if (!(probe.frameRate > 0)) return fallback;
  try {
    return frameRate(probe.frameRate);
  } catch {
    return fallback;
  }
}

// Resource ids are one namespace shared by assets and formats. Final Cut does not care
// what order the resources are declared in, so ids can be handed out as media is probed.
function createIds() {
  let next = 1;
  return () => `r${next++}`;
}

// One format per distinct frame size and frame duration. A format 'name' binds Final Cut
// to one of its own presets, so a custom size has to stay unnamed; the reserved
// 'FFVideoFormatRateUndefined' preset means "no frame rate" and belongs only on the
// rate-less audio clips, which is where Final Cut's own exports put it.
function createFormatTable(nextId, colorSpace) {
  const entries = new Map();

  function video({ width, height, rate }) {
    const frameDuration = timeFromFrames(1, rate);
    const key = `${width}x${height}@${frameDuration}`;
    if (!entries.has(key)) entries.set(key, { id: nextId(), width, height, frameDuration });
    return entries.get(key).id;
  }

  function rateUndefined() {
    if (!entries.has("rate-undefined")) entries.set("rate-undefined", { id: nextId() });
    return entries.get("rate-undefined").id;
  }

  function render() {
    return [...entries.values()].map((entry) => (entry.frameDuration
      ? `    <format id="${entry.id}" frameDuration="${entry.frameDuration}" width="${entry.width}" height="${entry.height}" colorSpace="${xml(colorSpace)}"/>`
      : `    <format id="${entry.id}" name="FFVideoFormatRateUndefined"/>`));
  }

  return { video, rateUndefined, render };
}

function renderAsset(asset) {
  const attributes = [`id="${asset.id}"`, `name="${xml(asset.name)}"`, `start="0s"`];
  if (asset.duration) attributes.push(`duration="${asset.duration}"`);
  if (asset.probe.hasVideo) {
    attributes.push(`hasVideo="1"`, `videoSources="1"`, `format="${asset.formatId}"`);
  }
  if (asset.probe.hasAudio) {
    attributes.push(
      `hasAudio="1"`,
      `audioSources="1"`,
      `audioChannels="${asset.probe.channels}"`,
      `audioRate="${asset.probe.sampleRate}"`
    );
  }
  return `    <asset ${attributes.join(" ")}>\n      <media-rep kind="original-media" src="${xml(asset.uri)}"/>\n    </asset>`;
}

export function buildFcpxml({
  project,
  channel,
  musicPath,
  soundEffects = [],
  libraryPath,
  version = DEFAULT_SCHEMA_VERSION
}) {
  const rate = frameRate(project.video.fps || 30);
  const configuredDuration = Number(project.video.duration || 0);
  const timedDuration = Number(project.timing.videoDuration || project.timing.narrationDuration || 0);
  const duration = Math.max(configuredDuration, timedDuration);
  if (duration <= 0) throw new Error("The project duration could not be determined.");

  const width = Number(project.video.width || 1920);
  const height = Number(project.video.height || 1080);
  const nextId = createIds();
  const formats = createFormatTable(nextId, channel.colorSpace || "1-1-1 (Rec. 709)");
  const sequenceFormatId = formats.video({ width, height, rate });

  const ranges = makeSceneRanges(project, duration);
  const neededDurationByPath = new Map(ranges.map((range) => [range.path, range.end - range.start]));
  const stillClipCacheDir = join(project.root, "final-cut", "stills-cache");

  const visuals = project.visuals.map((originalPath) => {
    const sourcePath = isStillImage(originalPath)
      ? ensureStillClip(originalPath, {
          fps: rate.fps,
          durationSeconds: neededDurationByPath.get(originalPath) || 1,
          cacheDir: stillClipCacheDir
        })
      : originalPath;
    const descriptor = assetDescriptor(sourcePath);
    if (!descriptor.probe.hasVideo) {
      throw new Error(`No readable video track in ${sourcePath}. Delete it and generate the visual again.`);
    }
    const assetRate = mediaRate(descriptor.probe, rate);
    return {
      ...descriptor,
      originalPath,
      id: nextId(),
      formatId: formats.video({
        width: descriptor.probe.width,
        height: descriptor.probe.height,
        rate: assetRate
      }),
      duration: descriptor.probe.duration > 0 ? time(descriptor.probe.duration, assetRate) : null,
      availableFrames: mediaFrames(descriptor.probe, rate)
    };
  });

  function audioAsset(path, extra = {}) {
    const descriptor = assetDescriptor(path);
    if (!descriptor.probe.hasAudio) {
      throw new Error(`No readable audio track in ${path}.`);
    }
    return {
      ...descriptor,
      ...extra,
      id: nextId(),
      duration: audioTime(descriptor.probe.duration, descriptor.probe.sampleRate),
      availableFrames: mediaFrames(descriptor.probe, rate)
    };
  }

  const narration = audioAsset(project.narrationPath);
  const music = musicPath ? audioAsset(musicPath) : null;
  const effects = soundEffects.map((effect) => audioAsset(effect.path, { at: Number(effect.at || 0) }));
  const audioFormatId = formats.rateUndefined();

  const mismatched = visuals.filter(
    (asset) => asset.probe.width !== width || asset.probe.height !== height
  );

  const visualByPath = new Map(visuals.map((asset) => [asset.originalPath, asset]));
  const projectName = (channel.projectNameTemplate || "{{title}}")
    .replaceAll("{{title}}", project.video.title || project.slug)
    .replaceAll("{{slug}}", project.slug);
  const eventName = channel.eventName || channel.name || "YouTube Imports";
  const roleNarration = channel.roles?.narration || "dialogue.narration";
  const roleMusic = channel.roles?.music || "music.background";
  const roleEffects = channel.roles?.effects || "effects.sound-effects";
  const frame = time(rate.numerator / rate.denominator, rate);

  const resources = [
    ...formats.render(),
    ...visuals.map(renderAsset),
    renderAsset(narration),
    ...(music ? [renderAsset(music)] : []),
    ...effects.map(renderAsset)
  ].join("\n");

  const totalFrames = frameCount(duration, rate);

  // Every anchored length is capped at what the file actually holds, so the timeline never
  // reaches past the end of a mix that came out shorter than the planned duration.
  function audioClip(asset, lane, role, atSeconds = 0) {
    const offsetFrames = Math.min(frameCount(atSeconds, rate), totalFrames);
    const room = Math.max(1, totalFrames - offsetFrames);
    const clipFrames = Math.max(1, Math.min(room, asset.availableFrames));
    return `          <asset-clip ref="${asset.id}" name="${xml(asset.name)}" lane="${lane}" offset="${timeFromFrames(offsetFrames, rate)}" start="0s" duration="${timeFromFrames(clipFrames, rate)}" format="${audioFormatId}" audioRole="${xml(role)}"/>`;
  }

  const anchoredAudio = [
    audioClip(narration, -1, roleNarration),
    ...(music ? [audioClip(music, -2, roleMusic)] : []),
    ...effects.map((effect, index) => audioClip(effect, -3 - index, roleEffects, effect.at))
  ];

  const boundaryFrames = ranges.map((range) => frameCount(range.start, rate));
  const items = [];
  ranges.forEach((range, index) => {
    const asset = visualByPath.get(range.path);
    const offsetFrames = boundaryFrames[index];
    const endFrames = index + 1 < ranges.length ? boundaryFrames[index + 1] : totalFrames;
    const wantedFrames = Math.max(1, endFrames - offsetFrames);
    const clipFrames = Math.max(1, Math.min(wantedFrames, asset.availableFrames || wantedFrames));
    const markerValue = range.line?.text || `Scene ${index + 1}`;
    const children = [];
    if (index === 0) children.push(...anchoredAudio);
    children.push(`          <marker start="0s" duration="${frame}" value="${xml(markerValue)}"/>`);
    items.push(`        <asset-clip ref="${asset.id}" name="${xml(asset.name)}" offset="${timeFromFrames(offsetFrames, rate)}" start="0s" duration="${timeFromFrames(clipFrames, rate)}" format="${asset.formatId}" videoRole="video">\n${children.join("\n")}\n        </asset-clip>`);
    // A visual shorter than its scene keeps its own length and leaves a gap, so every
    // later clip still lands on the offset the narration timings asked for.
    if (clipFrames < wantedFrames) {
      items.push(`        <gap name="Gap" offset="${timeFromFrames(offsetFrames + clipFrames, rate)}" start="0s" duration="${timeFromFrames(wantedFrames - clipFrames, rate)}"/>`);
    }
  });
  const clips = items.join("\n");

  const selectedLibraryPath = libraryPath || channel.libraryPath;
  const libraryLocation = selectedLibraryPath
    ? ` location="${xml(pathToFileURL(selectedLibraryPath).href)}"`
    : "";

  const document = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="${xml(version)}">
  <resources>
${resources}
  </resources>
  <library${libraryLocation} colorProcessing="standard">
    <event name="${xml(eventName)}">
      <project name="${xml(projectName)}">
        <sequence format="${sequenceFormatId}" duration="${time(duration, rate)}" tcStart="0s" tcFormat="NDF" audioLayout="${xml(channel.audioLayout || "stereo")}" audioRate="${sequenceAudioRate(channel.audioRate || 48000)}">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;

  return {
    document,
    warnings: mismatched.length
      ? [
          `${mismatched.length} of ${visuals.length} visuals are ${mismatched[0].probe.width}×${mismatched[0].probe.height}, ` +
            `but the project is set to ${width}×${height}. Final Cut will letterbox them. ` +
            `Fix width/height in the project's video.json if the timeline is the wrong shape.`
        ]
      : []
  };
}

export function parseSoundEffect(spec) {
  const split = spec.lastIndexOf("@");
  if (split === -1) return { path: spec, at: 0 };
  return { path: spec.slice(0, split), at: Number(spec.slice(split + 1)) };
}
