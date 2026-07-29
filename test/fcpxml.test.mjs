import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFcpxml, frameRate, parseSoundEffect, time } from "../src/fcpxml.mjs";
import { parseArgs } from "../src/args.mjs";

function ffmpegAvailable() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function fixtureProject(dir) {
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=black:s=1920x1080:r=30:d=3",
    "-c:v", "h264", "-pix_fmt", "yuv420p", join(dir, "01.mov")
  ], { stdio: "pipe" });
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3:sample_rate=48000",
    "-ac", "1", join(dir, "narration.wav")
  ], { stdio: "pipe" });

  return {
    root: dir,
    slug: "demo",
    video: { title: "Demo", width: 1920, height: 1080, fps: 30, duration: 3 },
    timing: { videoDuration: 3, lines: [{ text: "One line.", start: 0 }] },
    visuals: [join(dir, "01.mov")],
    narrationPath: join(dir, "narration.wav")
  };
}

test("uses exact broadcast frame rates", () => {
  assert.deepEqual(frameRate(29.97), { fps: 29.97, numerator: 1001, denominator: 30000 });
  assert.equal(time(1, frameRate(30)), "1/1s");
  assert.equal(time(1 / 30, frameRate(30)), "1/30s");
});

test("parses command options and sound effect positions", () => {
  assert.deepEqual(parseArgs(["export", "--project", "demo", "--open"]), {
    _: ["export"],
    project: "demo",
    open: true
  });
  assert.deepEqual(parseSoundEffect("/tmp/hit.wav@2.5"), { path: "/tmp/hit.wav", at: 2.5 });
});

test("declares only the media each file actually holds", (t) => {
  if (!ffmpegAvailable()) return t.skip("ffmpeg is not installed");
  const dir = mkdtempSync(join(tmpdir(), "fcp-bridge-"));
  try {
    const { document } = buildFcpxml({ project: fixtureProject(dir), channel: {} });

    // A silent visual must not claim audio; Final Cut checks this against the file.
    const visual = /<asset [^>]*name="01\.mov"[^>]*>/.exec(document)[0];
    assert.doesNotMatch(visual, /hasAudio/);
    assert.match(visual, /hasVideo="1"/);

    // Mono 48 kHz has to survive as mono 48 kHz.
    assert.match(document, /name="narration\.wav"[^>]*audioChannels="1" audioRate="48000"/);

    // The timeline format carries real dimensions and no preset name; the reserved
    // rate-undefined preset belongs only to the audio clip.
    assert.match(document, /<format id="r\d+" frameDuration="1\/30s" width="1920" height="1080"/);
    assert.match(document, /<format id="r\d+" name="FFVideoFormatRateUndefined"\/>/);
    assert.doesNotMatch(document, /name="FFVideoFormatRateUndefined" frameDuration/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps an edit inside the media it references", (t) => {
  if (!ffmpegAvailable()) return t.skip("ffmpeg is not installed");
  const dir = mkdtempSync(join(tmpdir(), "fcp-bridge-"));
  try {
    const project = fixtureProject(dir);
    // The scene asks for 6s from a 3s clip and 6s from a 3s narration mix.
    project.video = { ...project.video, duration: 6 };
    project.timing = { ...project.timing, videoDuration: 6 };
    const { document } = buildFcpxml({ project, channel: {} });

    assert.match(document, /name="01\.mov" offset="0\/1s" start="0s" duration="3\/1s"/);
    assert.match(document, /<gap name="Gap" offset="3\/1s" start="0s" duration="3\/1s"\/>/);
    assert.match(document, /name="narration\.wav" lane="-1"[^>]*duration="3\/1s"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warns when the visuals do not match the project frame size", (t) => {
  if (!ffmpegAvailable()) return t.skip("ffmpeg is not installed");
  const dir = mkdtempSync(join(tmpdir(), "fcp-bridge-"));
  try {
    const project = fixtureProject(dir);
    project.video = { ...project.video, width: 1080, height: 1920 };
    const { warnings } = buildFcpxml({ project, channel: {} });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /1920×1080.*1080×1920/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
