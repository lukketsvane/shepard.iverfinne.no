# Neural audio in Shepard

The rhythm engine stays in the browser. Neither RAVE nor Stable Audio 3 runs in the browser itself.

## Stable Audio 3 Small-SFX, Windows CPU

1. Install the official Windows CPU runtime from https://github.com/Stability-AI/stable-audio-3/tree/main/optimized/tflite and download the sm-sfx model once.
2. Set the path to the official sa3.ps1 script in PowerShell and start the local bridge:
   
       $env:SA3_CLI = "C:\path\to\stable-audio-3\optimized\tflite\sa3.ps1"
       npm run neural

3. Run npm run dev in a second terminal. In Shepard, open FX, then SA3. Choose Generate or Variation, provide a prompt (and a sample for Variation), generate and load the WAV into the existing percussion sampler.

The companion uses the official sm-sfx and same-s CPU runtime. It processes one generation at a time, binds only to localhost port 8789, and accepts only local Shepard or the official Shepard site as browser origins. It does not transmit your sound to a hosted generation API. Model weights are downloaded separately from the official provider. LoRA training remains in their original tooling.

## Neutone FX / IRCAM RAVE

Install Neutone FX from https://neutone.jp/fx in a DAW, load a compatible RAVE model, then route Neutone's output to a recording input on your computer. On Windows, a virtual cable such as https://vb-audio.com/Cable/ can provide that input. Open the RAVE panel in Shepard, grant audio permission, choose the input, monitor if desired, and capture audio to load it into the existing sampler.

Shepard does not host the VST3/AU or execute RAVE inside the browser. Avoid monitoring a physical microphone pointing at your speakers, which can feed back.

Note: Localhost on an iPhone does not point to your Windows computer. The CPU companion is for the browser on the computer where the model is running. To use the model on another device, deploy a separately secured private bridge.

## Combining the sound engines

The default portrait Shepard-Risset instrument stays unchanged.

In landscape, toggle 5:7:11 to add three real-time metrical streams to the original Shepard engine. All three streams restart each 4/4 bar and use exact integer-onset MIDI positions at PPQ 4620, with 5, 7 and 11 hits respectively. The download icon beside 5:7:11 exports an eight-bar MIDI file using the same timing. WIDTH sets HRTF source spread; ORBIT sets rotations per second. Use headphones for the spatial image. The additional voices are silent unless the 5:7:11 control is enabled.

Load a sample or generate a new texture with Stable Audio to use the same audio as a source for the 5:7:11 voices and the fingertip performance surface. RAVE can be processed in Neutone FX in your DAW and returned through a virtual input. Enabling MONITOR mixes the incoming live, already-transformed audio through Shepard's HRTF spatial chain and the WAV recorder. This does not install or run a RAVE model inside the web browser.

Alternatively, run MOSS-SoundEffect v2 using its separate documented environment from https://github.com/OpenMOSS/MOSS-TTS/tree/main/moss_soundeffect_v2, export WAV and import it with LOAD. MOSS-SoundEffect is a generator; MOSS-Audio is an understanding model. MOSS has not been bundled inside the lightweight browser app.

Run the deterministic regression check with npm run test:polyrhythm (Node 22 or later).
