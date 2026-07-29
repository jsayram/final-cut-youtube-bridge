# Final Cut YouTube Bridge

Turn a project from **YoutubeShort Pipeline** into an editable Final Cut Pro library/event/project
using Apple's supported FCPXML interchange format.

The bridge does not modify Final Cut library databases and does not modify the source pipeline. It
references the generated media files where they already live. Final Cut decides whether to leave
those files in place or copy them according to its import behavior and the destination library.

## Reusable Final Cut starter library

Import `templates/YouTube Starter Library.fcpxml` once with **File → Import → XML**. It creates:

- `YouTube 4K 16x9 — Starter`: 3840×2160, 30 fps, Rec. 709, stereo 48 kHz.
- `YouTube Short 9x16 — Starter`: 1080×1920, 30 fps, Rec. 709, stereo 48 kHz.
- Separate events for templates, incoming media, audio, active projects, and archived exports.

Duplicate the appropriate starter project inside Final Cut before beginning a manual edit. The
bridge-generated projects do not need this template: they automatically inherit width, height,
frame rate, and duration from each pipeline project's `video.json`, which avoids accidental
resizing or frame-rate conversion.

## What it creates

- A Final Cut project with the source project's width, height, frame rate, and duration.
- Generated images or video clips in scene order on the primary storyline.
- The mixed narration connected at the beginning with the `Dialogue > Narration` role.
- Optional music and sound effects on separate role lanes.
- A marker for every narration beat, containing the spoken line.
- A channel-specific event name, project name, color space, audio layout, and optional library path.

## First run

```bash
cd "/Users/jramirez/Git/final-cut-youtube-bridge"
npm run doctor
npm run export -- --project ordinary-tuesday
```

The XML is written to `exports/default/ordinary-tuesday.fcpxml`. Import it with **File → Import →
XML** in Final Cut, or add `--open` to send it directly to Final Cut:

```bash
npm run export -- --project ordinary-tuesday --open
```

Every export is validated against the newest `FCPXMLv*.dtd` that the installed Final Cut Pro
ships, and that same version goes into the document's `version` attribute. A document that fails
validation is left on disk and the command exits non-zero, so a broken assembly never looks like a
successful one.

Final Cut's own **Export XML** now writes a `.fcpxmld` bundle — a directory holding `Info.fcpxml`.
Give `--output` that extension to match it. Plain `.fcpxml` remains the default, because the
bundle format exists to carry media inside the document and the bridge references media where it
already lives:

```bash
npm run export -- --project ordinary-tuesday --output exports/default/ordinary-tuesday.fcpxmld
```

When launched from **YoutubeShort Pipeline Studio**, the pipeline supplies an output override and
writes the assembly beside the source project at
`videos/<slug>/final-cut/<slug>.fcpxml`. Studio creates this by default after image approval, then
continues through the existing HyperFrames composition and validation stages.

If the pipeline is moved, supply it explicitly:

```bash
npm run export -- \
  --source "/path/to/YoutubeShort Pipeline" \
  --project ordinary-tuesday
```

## Channel profiles

Copy `channels/example-channel.json` to a new lowercase channel ID such as
`channels/my-tech-channel.json`. Set:

- `eventName`: the event that receives imported projects.
- `projectNameTemplate`: supports `{{title}}` and `{{slug}}`.
- `libraryPath`: optional absolute path to that channel's `.fcpbundle`. Leave it `null` to choose
  the destination during import.
- `roles`: Final Cut audio subroles for narration, music, and effects.

Then export with:

```bash
npm run export -- --project ordinary-tuesday --channel my-tech-channel --open
```

Using one Final Cut library per channel is a clean default. Within each library, events can represent
years, months, series, or production stages.

## Music and effects

```bash
npm run export -- \
  --project ordinary-tuesday \
  --music "/absolute/path/to/music.wav" \
  --sfx "/absolute/path/to/impact.wav@1.5,/absolute/path/to/chime.wav@12"
```

Music is placed at time zero and plays for its available duration. Sound-effect positions use
timeline seconds. Media is not looped or altered; those remain editable choices in Final Cut.

## Recommended production workflow

Use the existing pipeline for scripting, image generation, narration, timing, and—when useful—an
automated HyperFrames draft. Use this bridge when you want a human-editable finishing timeline.

HyperFrames and Final Cut solve different problems:

- HyperFrames gives deterministic, repeatable motion design and unattended rendering.
- Final Cut gives fast editorial judgment, audio mixing, replacement shots, titles, color work, and
  manual publishing.

For channel work, the strongest default is a hybrid: generate assets and timing in the pipeline,
import an editable assembly into Final Cut, finish it there, then export/upload after review.

## Current boundary

FCPXML creates the editable assembly but cannot automate every inspector control, plugin, Motion
template, account selection, or YouTube upload field. Publishing should remain a deliberate Final
Cut action so the correct channel, title, description, thumbnail, audience setting, and visibility
are confirmed before upload.
