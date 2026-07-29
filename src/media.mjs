import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const VISUAL_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff", ".mov", ".mp4", ".m4v"]);
const STILL_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"]);

// Tail added to every generated still clip so trimming, retiming, or a rounded frame
// boundary can never push a scene past the end of its own media.
const STILL_HEADROOM_SECONDS = 0.5;

export function isStillImage(path) {
  return STILL_EXTENSIONS.has(extname(path).toLowerCase());
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function discoverPipeline(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.YOUTUBE_PIPELINE_DIR,
    resolve(process.cwd(), "../YoutubeShort Pipeline"),
    resolve(process.cwd(), "../youtubeshort-pipeline"),
    resolve(process.cwd(), "../YoutubeShort-Pipeline")
  ].filter(Boolean);

  const match = candidates.find((candidate) =>
    existsSync(join(resolve(candidate), "videos")) &&
    existsSync(join(resolve(candidate), "package.json"))
  );

  if (!match) {
    throw new Error("Could not find the YouTube pipeline. Pass --source /absolute/path/to/pipeline.");
  }
  return resolve(match);
}

export function loadPipelineProject(pipelineRoot, slug) {
  const root = join(pipelineRoot, "videos", slug);
  const videoPath = join(root, "video.json");
  const timingPath = join(root, "public", "audio", "narration.timing.json");
  const generatedPath = join(root, "public", "generated");

  if (!existsSync(videoPath)) throw new Error(`Missing ${videoPath}`);
  if (!existsSync(timingPath)) throw new Error(`Missing ${timingPath}. Generate narration first.`);
  if (!existsSync(generatedPath)) throw new Error(`Missing ${generatedPath}. Generate images first.`);

  const video = readJson(videoPath);
  const timing = readJson(timingPath);
  const visuals = readdirSync(generatedPath)
    .filter((name) => VISUAL_EXTENSIONS.has(extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => join(generatedPath, name));

  if (visuals.length === 0) throw new Error(`No generated visual assets found in ${generatedPath}`);

  const narrationPath = join(root, "public", timing.audio || "audio/narration.wav");
  if (!existsSync(narrationPath)) throw new Error(`Missing narration mix ${narrationPath}`);

  return { root, slug, video, timing, visuals, narrationPath };
}

function parseRatio(value) {
  const [numerator, denominator] = String(value || "").split("/");
  const top = Number(numerator);
  const bottom = Number(denominator ?? 1);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return 0;
  return top / bottom;
}

// Final Cut trusts an asset's declared attributes over the file itself, so an unreadable
// file has to report nothing rather than plausible defaults. Claiming audio channels or a
// frame size the media does not have is what makes the importer reject the document.
const UNKNOWN_MEDIA = {
  duration: 0,
  hasVideo: false,
  hasAudio: false,
  sampleRate: 0,
  channels: 0,
  width: 0,
  height: 0,
  frameRate: 0
};

export function probeMedia(path) {
  try {
    const output = execFileSync("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,sample_rate,channels,width,height,r_frame_rate",
      "-of", "json",
      path
    ], { encoding: "utf8" });
    const data = JSON.parse(output);
    const audio = data.streams?.find((stream) => stream.codec_type === "audio");
    const video = data.streams?.find((stream) => stream.codec_type === "video");
    return {
      duration: Number(data.format?.duration || 0),
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
      sampleRate: audio ? Number(audio.sample_rate || 48000) : 0,
      channels: audio ? Number(audio.channels || 2) : 0,
      width: Number(video?.width || 0),
      height: Number(video?.height || 0),
      frameRate: video ? parseRatio(video.r_frame_rate) : 0
    };
  } catch {
    return { ...UNKNOWN_MEDIA };
  }
}

// Final Cut Pro's FCPXML importer crashes (addAssetClip:toObject:parentFormatID:
// throws an uncaught exception) when an asset-clip is backed by a still image.
// Wrapping each still in a short silent video sidesteps the bug. The result is
// cached per project and only rebuilt when the source image changes.
export function ensureStillClip(imagePath, { fps, durationSeconds, cacheDir }) {
  mkdirSync(cacheDir, { recursive: true });
  const output = join(cacheDir, `${basename(imagePath, extname(imagePath))}.mov`);
  const needed = Math.max(1 / fps, Number(durationSeconds) || 0);
  if (!stillClipCovers(output, imagePath, needed)) {
    const encoded = Math.ceil((needed + STILL_HEADROOM_SECONDS) * fps) / fps;
    execFileSync("ffmpeg", [
      "-y",
      "-loop", "1",
      "-i", imagePath,
      "-an",
      "-c:v", "h264",
      "-pix_fmt", "yuv420p",
      "-r", String(fps),
      "-t", encoded.toFixed(6),
      output
    ], { stdio: "pipe" });
  }
  return output;
}

// A cached clip stays usable only while it is newer than its image and still long enough
// for the scene that references it. Checking the image alone left a clip from an earlier
// export in place after the narration timings moved, and a clip shorter than its own edit
// is an invalid range in Final Cut.
function stillClipCovers(output, imagePath, neededSeconds) {
  if (!existsSync(output)) return false;
  if (statSync(output).mtimeMs < statSync(imagePath).mtimeMs) return false;
  return probeMedia(output).duration >= neededSeconds;
}

export function assetDescriptor(path) {
  return {
    path: resolve(path),
    name: basename(path),
    uri: pathToFileURL(resolve(path)).href,
    probe: probeMedia(path)
  };
}
