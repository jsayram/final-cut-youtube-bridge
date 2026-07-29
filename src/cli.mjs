#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "./args.mjs";
import { buildFcpxml, parseSoundEffect } from "./fcpxml.mjs";
import { discoverPipeline, loadPipelineProject, readJson } from "./media.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "help";

function usage() {
  console.log(`
Final Cut YouTube Bridge

  npm run doctor
  npm run export -- --project <slug> [options]

Options:
  --source <path>          YouTubeShort Pipeline directory
  --channel <id>           JSON profile from channels/ (default: default)
  --output <path>          Destination .fcpxml file, or .fcpxmld for a bundle
  --library-path <path>    Create/import into this .fcpbundle location
  --music <path>           Add a music file with the Music role
  --sfx <path@seconds>     Add a sound effect; repeatable only with comma-separated values
  --open                   Open the generated XML in Final Cut Pro
`);
}

function loadChannel(id) {
  const path = join(appRoot, "channels", `${id}.json`);
  if (!existsSync(path)) throw new Error(`Channel profile not found: ${path}`);
  return readJson(path);
}

const INTERCHANGE_RESOURCES =
  "/Applications/Final Cut Pro.app/Contents/Frameworks/Interchange.framework/Versions/A/Resources";

// Final Cut ships one DTD per interchange version and each DTD pins the document's
// 'version' attribute to itself, so the newest installed DTD decides what we may write.
function newestSchema() {
  if (!existsSync(INTERCHANGE_RESOURCES)) return null;
  const schemas = readdirSync(INTERCHANGE_RESOURCES)
    .map((name) => ({ name, parts: /^FCPXMLv(\d+)_(\d+)\.dtd$/.exec(name) }))
    .filter((entry) => entry.parts)
    .map(({ name, parts }) => ({
      path: join(INTERCHANGE_RESOURCES, name),
      version: `${Number(parts[1])}.${Number(parts[2])}`,
      rank: Number(parts[1]) * 1000 + Number(parts[2])
    }))
    .sort((left, right) => right.rank - left.rank);
  return schemas[0] ?? null;
}

function validateXml(path, schema) {
  if (!schema) return { validated: false, reason: "no Final Cut Pro FCPXML DTD is installed" };
  try {
    execFileSync("xmllint", ["--noout", "--dtdvalid", pathToFileURL(schema.path).href, path], { stdio: "pipe" });
    return { validated: true };
  } catch (error) {
    return { validated: false, invalid: true, reason: String(error.stderr || error.message).trim() };
  }
}

// A '.fcpxmld' document is a bundle directory holding 'Info.fcpxml' — the shape Final Cut
// writes now. A plain '.fcpxml' file still imports and stays the default, since the
// pipeline and Studio address the export as a single file.
function writeDocument(output, content) {
  if (output.toLowerCase().endsWith(".fcpxmld")) {
    mkdirSync(output, { recursive: true });
    const info = join(output, "Info.fcpxml");
    writeFileSync(info, content, "utf8");
    return info;
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, content, "utf8");
  return output;
}

function doctor() {
  const schema = newestSchema();
  const checks = [
    ["Node.js 22+", Number(process.versions.node.split(".")[0]) >= 22],
    ["Final Cut Pro", existsSync("/Applications/Final Cut Pro.app")],
    [`FCPXML schema${schema ? ` ${schema.version}` : ""}`, Boolean(schema)]
  ];
  let ok = true;
  for (const [label, passed] of checks) {
    console.log(`${passed ? "✓" : "✗"} ${label}`);
    ok &&= passed;
  }
  try {
    console.log(`✓ YouTube pipeline: ${discoverPipeline(args.source)}`);
  } catch (error) {
    console.log(`✗ ${error.message}`);
    ok = false;
  }
  if (!ok) process.exitCode = 1;
}

function exportProject() {
  if (!args.project) throw new Error("--project is required.");
  const pipeline = discoverPipeline(args.source);
  const project = loadPipelineProject(pipeline, args.project);
  const channelId = args.channel || "default";
  const channel = loadChannel(channelId);
  const output = resolve(args.output || join(appRoot, "exports", channelId, `${args.project}.fcpxml`));
  const sfxSpecs = args.sfx
    ? String(args.sfx).split(",").filter(Boolean).map(parseSoundEffect)
    : [];

  const schema = newestSchema();
  const { document, warnings } = buildFcpxml({
    project,
    channel,
    musicPath: args.music ? resolve(args.music) : null,
    soundEffects: sfxSpecs.map((effect) => ({ ...effect, path: resolve(effect.path) })),
    libraryPath: args.libraryPath ? resolve(args.libraryPath) : null,
    version: schema?.version
  });

  const written = writeDocument(output, document);
  const result = validateXml(written, schema);
  console.log(`Created: ${output}`);
  console.log(`Project: ${project.video.title || project.slug} (${project.video.width}×${project.video.height} at ${project.video.fps} fps)`);
  console.log(`Media: ${project.visuals.length} visuals + narration${args.music ? " + music" : ""}${sfxSpecs.length ? ` + ${sfxSpecs.length} sound effect(s)` : ""}`);
  for (const warning of warnings) console.log(`! ${warning}`);
  if (result.invalid) {
    throw new Error(
      `${written} failed Final Cut Pro's FCPXML ${schema.version} schema:\n${result.reason}`
    );
  }
  console.log(result.validated
    ? `Validated against Final Cut Pro's installed FCPXML ${schema.version} schema.`
    : `Schema validation skipped: ${result.reason}`);

  if (args.open) {
    execFileSync("/usr/bin/open", ["-a", "Final Cut Pro", output]);
    console.log("Opened in Final Cut Pro.");
  }
}

try {
  if (command === "doctor") doctor();
  else if (command === "export") exportProject();
  else usage();
} catch (error) {
  console.error(`Error: ${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exitCode = 1;
}
