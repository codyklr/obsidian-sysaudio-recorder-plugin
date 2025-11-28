import {
  App,
  Editor,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import * as path from "path";
// @ts-ignore
import fixWebmDuration from "fix-webm-duration";

interface AudioRecorderSettings {
  recordingsFolder: string;
  recordMicrophone: boolean;
  selectedMicrophoneId: string;
  muteHotkey: string; // Global hotkey for mute toggle
  outputFormat: "webm" | "wav";
  enableTranscription: boolean;
  transcriptionMethod: "local" | "api";
  whisperApiKey: string;
  whisperCppPath: string;
  whisperModel:
    | "tiny"
    | "tiny.en"
    | "base"
    | "base.en"
    | "small"
    | "small.en"
    | "medium"
    | "medium.en"
    | "large-v1"
    | "large-v2"
    | "large-v3";
}

const DEFAULT_SETTINGS: AudioRecorderSettings = {
  recordingsFolder: "Recordings",
  recordMicrophone: true,
  selectedMicrophoneId: "default",
  muteHotkey: "CommandOrControl+Shift+M", // Default global hotkey
  outputFormat: "webm",
  enableTranscription: false,
  transcriptionMethod: "local",
  whisperModel: "base.en",
  whisperApiKey: "",
  whisperCppPath: "",
};

export default class AudioRecorderPlugin extends Plugin {
  settings: AudioRecorderSettings;
  recorder: MediaRecorder | null = null;
  chunks: Blob[] = [];
  recordingStream: MediaStream | null = null;
  micStream: MediaStream | null = null;
  audioContext: AudioContext | null = null;
  micGainNode: GainNode | null = null;
  isMicMuted: boolean = false;
  analyserNode: AnalyserNode | null = null;
  statusBarItem: HTMLElement | null = null;
  activeFileAtStart: TFile | null = null;
  controlWindow: any = null; // BrowserWindow
  processorNode: ScriptProcessorNode | null = null;
  muteGainNode: GainNode | null = null;
  animationIntervalId: NodeJS.Timeout | null = null;
  electron: any = null; // Electron reference
  startTime: number = 0;

  // Audio properties
  sampleRate: number = 44100;
  numChannels: number = 2;

  // Transcription properties
  isTranscribing: boolean = false;
  transcriptionProcessor: ScriptProcessorNode | null = null;
  transcriptionBuffer: Float32Array[] = [];
  transcriptionChunkIndex: number = 0;
  transcriptionText: string = ""; // Accumulated transcription text
  transcriptionQueue: Array<{ audioData: Float32Array; timestamp: number }> =
    [];
  isProcessingQueue: boolean = false;
  lastTranscriptionText: string = ""; // For deduplication

  async onload() {
    await this.loadSettings();

    // Ribbon Icon
    const ribbonIconEl = this.addRibbonIcon(
      "microphone",
      "Start/Stop Recording",
      (evt: MouseEvent) => {
        this.toggleRecording();
      },
    );
    ribbonIconEl.addClass("audio-recorder-ribbon-class");

    // Status Bar
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText("");

    // Command
    this.addCommand({
      id: "start-stop-recording",
      name: "Start/Stop Recording",
      callback: () => {
        this.toggleRecording();
      },
    });

    // Mute Toggle Command with Hotkey
    this.addCommand({
      id: "toggle-mic-mute",
      name: "Toggle Microphone Mute",
      callback: () => {
        this.toggleMute();
      },
    });

    // Show Control Window Command
    this.addCommand({
      id: "show-control-window",
      name: "Show Recording Control Window",
      callback: () => {
        this.showControlWindow();
      },
    });

    // Settings
    this.addSettingTab(new AudioRecorderSettingTab(this.app, this));
  }

  onunload() {
    this.stopRecording();
    this.unregisterGlobalHotkey();
  }

  async toggleRecording() {
    if (this.recorder && this.recorder.state === "recording") {
      this.stopRecording();
    } else {
      this.startRecording();
    }
  }

  toggleMute() {
    // Only allow muting during active recording
    const isRecording = this.recorder && this.recorder.state === "recording";

    if (!isRecording) {
      new Notice("No active recording to mute/unmute microphone.");
      return;
    }

    if (!this.micGainNode) {
      new Notice("Microphone is not being recorded.");
      return;
    }

    this.isMicMuted = !this.isMicMuted;
    this.micGainNode.gain.value = this.isMicMuted ? 0 : 1;

    // Update the control window if it exists
    if (this.controlWindow && !this.controlWindow.isDestroyed()) {
      this.controlWindow.webContents.send("toggle-mute-state", this.isMicMuted);
    }

    new Notice(this.isMicMuted ? "Microphone muted" : "Microphone unmuted");
  }

  async startRecording() {
    try {
      this.activeFileAtStart = this.app.workspace.getActiveFile();

      // Use Electron's desktopCapturer to get sources
      // @ts-ignore
      const electron = require("electron");
      this.electron = electron; // Store for later use
      let desktopCapturer = electron.desktopCapturer;
      let remote = electron.remote;

      // Fallback for some Electron versions/configs
      if (!desktopCapturer && remote) {
        desktopCapturer = remote.desktopCapturer;
      }

      if (!desktopCapturer) {
        new Notice("Error: desktopCapturer API is not available.");
        return;
      }

      // Register global hotkey for mute toggle
      this.registerGlobalHotkey();

      // Auto-select the first screen (Primary Display)
      const sources = await desktopCapturer.getSources({ types: ["screen"] });
      if (sources.length === 0) {
        new Notice("No screen sources found.");
        return;
      }
      const source = sources[0]; // Primary screen

      // 1. Get System Audio Stream
      const systemStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: source.id,
          },
        },
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: source.id,
          },
        },
      } as any);

      // Check system audio tracks
      const systemAudioTracks = systemStream.getAudioTracks();
      if (systemAudioTracks.length === 0) {
        new Notice(
          "No system audio track captured. Ensure you are on Windows or have system audio setup.",
        );
      }

      this.recordingStream = systemStream;

      // 2. Get Microphone Stream (if enabled)
      if (this.settings.recordMicrophone) {
        try {
          const constraints: any = { audio: true };
          if (
            this.settings.selectedMicrophoneId &&
            this.settings.selectedMicrophoneId !== "default"
          ) {
            constraints.audio = {
              deviceId: { exact: this.settings.selectedMicrophoneId },
            };
          }

          this.micStream =
            await navigator.mediaDevices.getUserMedia(constraints);
        } catch (micErr) {
          console.error("Error capturing microphone:", micErr);
          new Notice(
            "Failed to capture microphone. Recording system audio only.",
          );
        }
      }

      // 3. Mix Streams & Setup Audio Context
      let finalStream: MediaStream;
      this.audioContext = new AudioContext();
      this.sampleRate = this.audioContext.sampleRate; // Capture actual sample rate
      const destination = this.audioContext.createMediaStreamDestination();

      // Create a Master Gain Node to mix everything before sending to destination/analyser
      const masterGain = this.audioContext.createGain();
      masterGain.connect(destination);

      // Setup Analyser
      this.analyserNode = this.audioContext.createAnalyser();
      this.analyserNode.fftSize = 128;
      this.analyserNode.smoothingTimeConstant = 0.5;
      masterGain.connect(this.analyserNode);

      // System Audio Node
      if (systemAudioTracks.length > 0) {
        const systemSource =
          this.audioContext.createMediaStreamSource(systemStream);
        systemSource.connect(masterGain);
      }

      // Mic Audio Node
      if (this.micStream) {
        const micSource = this.audioContext.createMediaStreamSource(
          this.micStream,
        );
        this.micGainNode = this.audioContext.createGain();
        this.micGainNode.gain.value = 1.0;
        micSource.connect(this.micGainNode);
        this.micGainNode.connect(masterGain);
      }

      finalStream = destination.stream;

      if (finalStream.getAudioTracks().length === 0) {
        new Notice("No audio tracks available to record.");
        this.stopRecordingStreams();
        return;
      }

      // Always use MediaRecorder (WebM) for recording
      // If WAV is selected, we'll convert it after recording stops
      this.recorder = new MediaRecorder(finalStream, {
        mimeType: "audio/webm",
      });
      this.chunks = [];

      this.recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.chunks.push(e.data);
        }
      };

      this.recorder.onstop = async () => {
        const webmBlob = new Blob(this.chunks, { type: "audio/webm" });

        let finalBlob: Blob;
        if (this.settings.outputFormat === "wav") {
          // Convert WebM to WAV
          new Notice("Converting to WAV...");
          finalBlob = await this.convertWebMToWAV(webmBlob);
        } else {
          // Keep as WebM
          finalBlob = webmBlob;
        }

        await this.saveRecording(finalBlob);
        this.stopRecordingStreams();
        this.statusBarItem?.setText("");
        new Notice("Recording saved.");
        this.closeControlWindow();
      };

      this.recorder.start();

      this.startTime = Date.now();
      this.statusBarItem?.setText("Recording...");
      new Notice("Recording started.");

      // Open Control Window
      this.openControlWindow(electron);
      this.startAudioVisualization();
    } catch (err) {
      console.error("Error starting recording:", err);
      new Notice("Failed to start recording. See console for details.");
      this.stopRecordingStreams();
    }
  }

  openControlWindow(electron: any) {
    const remote = electron.remote || electron;
    const BrowserWindow = remote.BrowserWindow;
    const ipcMain = remote.ipcMain;

    // Calculate position (bottom center)
    const { width, height } = remote.screen.getPrimaryDisplay().workAreaSize;

    this.controlWindow = new BrowserWindow({
      width: 320,
      height: 110,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000", // Force transparency
      hasShadow: false, // Disable native shadow to prevent black corners
      alwaysOnTop: true,
      resizable: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        backgroundThrottling: false, // Prevent throttling when in background
      },
      x: Math.floor(width / 2 - 160),
      y: height - 110,
    });

    // Load HTML
    // @ts-ignore
    const pluginDir = this.app.vault.adapter.basePath + "/" + this.manifest.dir;
    const htmlPath = path.join(pluginDir, "control-window.html");
    this.controlWindow.loadFile(htmlPath);

    this.controlWindow.webContents.on("did-finish-load", () => {
      // Get Obsidian's accent color from CSS variables
      const accentColor =
        getComputedStyle(document.body).getPropertyValue(
          "--interactive-accent",
        ) || "#7c3aed"; // Fallback to purple
      this.controlWindow.webContents.send("set-accent-color", accentColor);

      // Send transcription settings
      this.controlWindow.webContents.send("transcription-settings", {
        enabled: this.settings.enableTranscription,
      });
    });

    // IPC Handlers
    const onMuteMic = () => {
      if (this.micGainNode) {
        this.micGainNode.gain.value = 0;
        this.isMicMuted = true;
      }
    };
    const onUnmuteMic = () => {
      if (this.micGainNode) {
        this.micGainNode.gain.value = 1;
        this.isMicMuted = false;
      }
    };
    const onStopRecording = () => {
      this.stopRecording();
    };
    const onToggleTranscription = () => {
      this.toggleTranscription();
    };
    const onResizeControlWindow = (
      event: any,
      width: number,
      height: number,
    ) => {
      if (this.controlWindow && !this.controlWindow.isDestroyed()) {
        // Get current position
        const currentBounds = this.controlWindow.getBounds();

        // Keep top-left corner fixed, grow/shrink downward
        // This way the window stays in place and just expands/contracts below
        this.controlWindow.setBounds({
          x: currentBounds.x,
          y: currentBounds.y, // Keep Y position fixed
          width: width,
          height: height,
        });
      }
    };

    ipcMain.on("mute-mic", onMuteMic);
    ipcMain.on("unmute-mic", onUnmuteMic);
    ipcMain.on("stop-recording", onStopRecording);
    ipcMain.on("toggle-transcription", onToggleTranscription);
    ipcMain.on("resize-control-window", onResizeControlWindow);

    // Handle window focus/restore events
    this.controlWindow.on("blur", () => {
      // When window loses focus, ensure it can be restored
      if (this.controlWindow && !this.controlWindow.isDestroyed()) {
        this.controlWindow.setAlwaysOnTop(false);
        this.controlWindow.setAlwaysOnTop(true);
      }
    });

    this.controlWindow.on("focus", () => {
      // When window regains focus, ensure it's visible and on top
      if (this.controlWindow && !this.controlWindow.isDestroyed()) {
        this.controlWindow.show();
        this.controlWindow.focus();
      }
    });

    this.controlWindow.on("minimize", (event: any) => {
      // Prevent minimizing, just restore to front
      event.preventDefault();
      if (this.controlWindow && !this.controlWindow.isDestroyed()) {
        this.controlWindow.restore();
        this.controlWindow.focus();
      }
    });

    // Cleanup on window close
    this.controlWindow.on("closed", () => {
      ipcMain.removeListener("mute-mic", onMuteMic);
      ipcMain.removeListener("unmute-mic", onUnmuteMic);
      ipcMain.removeListener("stop-recording", onStopRecording);
      ipcMain.removeListener("toggle-transcription", onToggleTranscription);
      ipcMain.removeListener("resize-control-window", onResizeControlWindow);
      this.controlWindow = null;
    });
  }

  showControlWindow() {
    if (this.controlWindow && !this.controlWindow.isDestroyed()) {
      this.controlWindow.show();
      this.controlWindow.restore();
      this.controlWindow.focus();
      this.controlWindow.setAlwaysOnTop(true);
      new Notice("Control window restored.");
    } else if (!this.recorder || this.recorder.state !== "recording") {
      new Notice("No recording in progress.");
    }
  }

  closeControlWindow() {
    if (this.controlWindow) {
      this.controlWindow.close();
      this.controlWindow = null;
    }

    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    if (this.muteGainNode) {
      this.muteGainNode.disconnect();
      this.muteGainNode = null;
    }
  }

  startAudioVisualization() {
    if (!this.analyserNode || !this.controlWindow || !this.audioContext) return;

    const dataArray = new Uint8Array(this.analyserNode.frequencyBinCount);

    this.processorNode = this.audioContext.createScriptProcessor(2048, 1, 1);

    this.muteGainNode = this.audioContext.createGain();
    this.muteGainNode.gain.value = 0;

    this.analyserNode.connect(this.processorNode);
    this.processorNode.connect(this.muteGainNode);
    this.muteGainNode.connect(this.audioContext.destination);

    this.processorNode.onaudioprocess = () => {
      if (!this.analyserNode || !this.controlWindow) {
        if (this.processorNode) {
          this.processorNode.disconnect();
          this.processorNode = null;
        }
        return;
      }

      this.analyserNode.getByteFrequencyData(dataArray);

      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length / 255;

      try {
        if (!this.controlWindow.isDestroyed()) {
          this.controlWindow.webContents.send("audio-level", average);
        }
      } catch (err) {
        // Window might be closed
      }
    };
  }

  toggleTranscription() {
    if (this.isTranscribing) {
      this.stopTranscription();
    } else {
      this.startTranscription();
    }
  }

  startTranscription() {
    if (!this.settings.enableTranscription || this.isTranscribing) return;
    if (!this.recorder || this.recorder.state !== "recording") return;

    this.isTranscribing = true;
    this.transcriptionBuffer = [];
    this.transcriptionChunkIndex = 0;
    this.transcriptionText = ""; // Reset transcription text

    this.startLocalTranscription();

    if (this.controlWindow && !this.controlWindow.isDestroyed()) {
      this.controlWindow.webContents.send("transcription-started");
    }
  }

  async startLocalTranscription() {
    if (!this.audioContext) return;

    // Create a ScriptProcessorNode to capture audio
    this.transcriptionProcessor = this.audioContext.createScriptProcessor(
      4096,
      this.numChannels,
      this.numChannels,
    );

    // Connect to analyser node
    if (this.analyserNode) {
      this.analyserNode.connect(this.transcriptionProcessor);
    }

    // Process audio samples
    this.transcriptionProcessor.onaudioprocess = async (event) => {
      if (!this.isTranscribing) return;

      // Get audio data and mix to mono
      const channelData: Float32Array[] = [];
      for (
        let channel = 0;
        channel < event.inputBuffer.numberOfChannels;
        channel++
      ) {
        channelData.push(event.inputBuffer.getChannelData(channel));
      }

      const monoData = new Float32Array(channelData[0].length);
      for (let i = 0; i < monoData.length; i++) {
        let sum = 0;
        for (let channel = 0; channel < channelData.length; channel++) {
          sum += channelData[channel][i];
        }
        monoData[i] = sum / channelData.length;
      }

      this.transcriptionBuffer.push(monoData);

      // Process every 2 seconds - no overlap to prevent duplicates
      const totalSamples = this.transcriptionBuffer.reduce(
        (sum, arr) => sum + arr.length,
        0,
      );
      const samplesPerChunk = this.sampleRate * 2; // 2 seconds of audio

      if (totalSamples >= samplesPerChunk) {
        const combined = new Float32Array(totalSamples);
        let offset = 0;
        for (const chunk of this.transcriptionBuffer) {
          combined.set(chunk, offset);
          offset += chunk.length;
        }

        // Extract exactly 2 seconds, no overlap
        const audioChunk = combined.slice(0, samplesPerChunk);

        // Keep remaining samples in buffer
        const remaining = combined.slice(samplesPerChunk);
        this.transcriptionBuffer = remaining.length > 0 ? [remaining] : [];

        // Queue the chunk for async processing
        this.queueTranscription(audioChunk);
      }
    };

    // Connect to muted destination
    const mutedGain = this.audioContext.createGain();
    mutedGain.gain.value = 0;
    this.transcriptionProcessor.connect(mutedGain);
    mutedGain.connect(this.audioContext.destination);
  }

  queueTranscription(audioData: Float32Array) {
    // Add to queue with timestamp
    this.transcriptionQueue.push({
      audioData: audioData,
      timestamp: Date.now(),
    });

    // Start processing queue if not already running
    if (!this.isProcessingQueue) {
      this.processTranscriptionQueue();
    }
  }

  async processTranscriptionQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.transcriptionQueue.length > 0) {
      const item = this.transcriptionQueue.shift();
      if (item) {
        try {
          await this.transcribeAudioChunk(item.audioData);
        } catch (err) {
          console.error("Error processing transcription from queue:", err);
        }
      }
    }

    this.isProcessingQueue = false;
  }

  deduplicateTranscription(newText: string): string {
    // Without audio overlap, we just need to check if this is an exact duplicate
    // (in case whisper processes the same chunk twice)
    if (
      this.lastTranscriptionText &&
      newText.toLowerCase().trim() ===
        this.lastTranscriptionText.toLowerCase().trim()
    ) {
      return ""; // Skip exact duplicates
    }

    return newText;
  }

  async transcribeAudioChunk(audioData: Float32Array) {
    try {
      const fs = require("fs");
      const path = require("path");
      const os = require("os");
      const { spawn } = require("child_process");

      // Detect whisper.cpp location
      let whisperPath = this.settings.whisperCppPath;

      if (!whisperPath || !fs.existsSync(whisperPath)) {
        // Try to find in PATH
        whisperPath = await this.findWhisperCpp();
      }

      if (!whisperPath) {
        throw new Error(
          "whisper.cpp not found. Please install it or set the path in settings.",
        );
      }

      // Get plugin directory
      const pluginDir = path.join(
        (this.app.vault.adapter as any).getBasePath(),
        ".obsidian",
        "plugins",
        this.manifest.id,
      );

      // Create temp directory inside plugin folder
      const tempDir = path.join(pluginDir, "temp");
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // Save audio to temp WAV file
      const chunkFileName = `chunk_${this.transcriptionChunkIndex++}`;
      const tempWavPath = path.join(tempDir, `${chunkFileName}.wav`);

      const wavData = this.createWavFile(audioData, 16000);
      fs.writeFileSync(tempWavPath, Buffer.from(wavData.buffer));

      // Use the selected model from settings
      const modelPath = path.join(
        pluginDir,
        "models",
        `ggml-${this.settings.whisperModel}.bin`,
      );

      // If model not found, show error with instructions
      if (!fs.existsSync(modelPath)) {
        throw new Error(
          `Whisper model (${this.settings.whisperModel}) not found. Please download it from the plugin settings (Settings → Audio Recorder → Download Model button).`,
        );
      }

      // Determine if this is whisper.cpp or Python whisper
      // whisper.cpp uses -m flag, Python whisper uses different args
      const isPythonWhisper =
        whisperPath.includes("Python") ||
        whisperPath.toLowerCase().includes("scripts");

      let whisperProcess: any;
      let outputTxtPath: string;
      let outputBasePath: string;

      if (isPythonWhisper) {
        // This is OpenAI's Python whisper - not supported yet
        throw new Error(
          "Detected OpenAI's Python Whisper. This plugin requires whisper.cpp. " +
            "Please install whisper.cpp from https://github.com/ggerganov/whisper.cpp/releases",
        );
      } else {
        // This is whisper.cpp - use proper command line args
        outputBasePath = path.join(tempDir, chunkFileName);
        outputTxtPath = `${outputBasePath}.txt`;

        const args = [
          "-m",
          modelPath,
          "-f",
          tempWavPath,
          "-otxt",
          "-of",
          outputBasePath,
          "--no-timestamps",
          "-l",
          "en",
          "--no-prints", // Reduce output overhead
          "-t",
          "6", // Use 6 threads for faster processing
          "-p",
          "1", // Processors: 1 for fastest
        ];

        whisperProcess = spawn(whisperPath, args);
      }

      let stderr = "";
      let stdout = "";

      whisperProcess.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        stderr += text;
      });

      whisperProcess.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        stdout += text;
      });

      // Wait for completion
      await new Promise<void>((resolve, reject) => {
        whisperProcess.on("close", (code: number) => {
          // Log whisper output for debugging
          if (stdout) console.log("Whisper stdout:", stdout);
          if (stderr) console.log("Whisper stderr:", stderr);

          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                `Whisper exited with code ${code}. Stderr: ${stderr || "none"}, Stdout: ${stdout || "none"}`,
              ),
            );
          }
        });

        whisperProcess.on("error", (err: Error) => {
          console.error("Whisper process error:", err);
          reject(err);
        });
      });

      // Read output - whisper.cpp may append language code to filename
      let actualOutputPath = outputTxtPath;

      // Check common filename variations whisper.cpp might create
      const possiblePaths = [
        outputTxtPath,
        `${outputBasePath}.en.txt`, // whisper may add .en before .txt
      ];

      for (const testPath of possiblePaths) {
        if (fs.existsSync(testPath)) {
          actualOutputPath = testPath;
          break;
        }
      }

      if (fs.existsSync(actualOutputPath)) {
        let transcriptionText = fs
          .readFileSync(actualOutputPath, "utf-8")
          .trim();

        // Filter out [BLANK_AUDIO] markers
        transcriptionText = transcriptionText
          .replace(/\[BLANK_AUDIO\]/g, "")
          .trim();

        if (transcriptionText) {
          // Deduplicate overlapping text
          const newText = this.deduplicateTranscription(transcriptionText);

          if (newText) {
            // Accumulate transcription text
            this.transcriptionText += newText + " ";
            this.lastTranscriptionText = transcriptionText;

            if (this.controlWindow && !this.controlWindow.isDestroyed()) {
              this.controlWindow.webContents.send("transcription-update", {
                text: this.transcriptionText, // Send accumulated text
                interim: "",
              });
            } else {
              // Fallback: show transcription as a notice
              new Notice(`Transcription: ${newText}`, 5000);
            }
          }
        }

        // Update outputTxtPath for cleanup
        outputTxtPath = actualOutputPath;
      } else {
        console.error(
          `Output file not found. Checked: ${possiblePaths.join(", ")}`,
        );
        // List what files are actually in the temp directory
        try {
          const filesInTemp = fs.readdirSync(tempDir);
          console.error(`Files in temp dir: ${filesInTemp.join(", ")}`);
        } catch (e) {
          console.error(`Could not list temp directory`);
        }
      }

      // Cleanup temp files
      try {
        if (fs.existsSync(tempWavPath)) {
          fs.unlinkSync(tempWavPath);
        }
        if (fs.existsSync(outputTxtPath)) {
          fs.unlinkSync(outputTxtPath);
        }
      } catch (err) {
        // Silently ignore cleanup errors
      }
    } catch (err) {
      console.error("Error transcribing audio chunk:", err);
      if (this.controlWindow && !this.controlWindow.isDestroyed()) {
        this.controlWindow.webContents.send(
          "transcription-error",
          err.message || "Transcription failed",
        );
      }
    }
  }

  async findWhisperCpp(): Promise<string | null> {
    const fs = require("fs");
    const path = require("path");
    const { spawn } = require("child_process");
    const os = require("os");

    const platform = os.platform();

    // First, check if we have it in the plugin's bin folder
    const binDir = path.join(
      (this.app.vault.adapter as any).getBasePath(),
      ".obsidian",
      "plugins",
      this.manifest.id,
      "bin",
    );

    const localExecutableName = platform === "win32" ? "main.exe" : "main";
    const localExecutablePath = path.join(binDir, localExecutableName);

    if (fs.existsSync(localExecutablePath)) {
      return localExecutablePath;
    }

    // If not found locally, search in PATH
    const commands =
      platform === "win32"
        ? ["whisper.exe", "main.exe", "whisper-cli.exe"]
        : ["whisper", "whisper.cpp", "main"];

    for (const cmd of commands) {
      try {
        const which = platform === "win32" ? "where" : "which";
        const result = await new Promise<string>((resolve, reject) => {
          const proc = spawn(which, [cmd]);
          let output = "";

          proc.stdout.on("data", (data: Buffer) => {
            output += data.toString();
          });

          proc.on("close", (code: number) => {
            if (code === 0 && output.trim()) {
              resolve(output.trim().split("\n")[0]);
            } else {
              reject();
            }
          });
        });

        return result;
      } catch (err) {
        // Command not found, try next
      }
    }

    return null;
  }

  async stopTranscription() {
    this.isTranscribing = false;

    if (this.transcriptionProcessor) {
      this.transcriptionProcessor.disconnect();
      this.transcriptionProcessor = null;
    }

    // Wait for remaining queue items to be processed
    if (this.transcriptionQueue.length > 0) {
      new Notice(
        `Processing remaining ${this.transcriptionQueue.length} transcription chunks...`,
      );

      // Wait for queue to be empty
      while (this.transcriptionQueue.length > 0 || this.isProcessingQueue) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      new Notice("All transcription chunks processed!");
    }

    this.transcriptionBuffer = [];
    this.transcriptionQueue = [];
    this.lastTranscriptionText = "";

    if (this.controlWindow && !this.controlWindow.isDestroyed()) {
      this.controlWindow.webContents.send("transcription-stopped");
    }
  }

  async stopRecording() {
    // Stop transcription first and wait for queue to finish
    if (this.isTranscribing) {
      await this.stopTranscription();
    }

    if (this.recorder && this.recorder.state === "recording") {
      this.recorder.stop();
    }
    this.unregisterGlobalHotkey();
  }

  async convertWebMToWAV(webmBlob: Blob): Promise<Blob> {
    // Decode WebM to raw audio data
    const arrayBuffer = await webmBlob.arrayBuffer();
    const audioBuffer = await this.audioContext!.decodeAudioData(arrayBuffer);

    // Update sample rate from decoded audio
    this.sampleRate = audioBuffer.sampleRate;
    this.numChannels = audioBuffer.numberOfChannels;

    // Extract channel data
    const channels: Float32Array[] = [];
    for (let i = 0; i < this.numChannels; i++) {
      channels.push(audioBuffer.getChannelData(i));
    }

    // Interleave channels
    let interleaved: Float32Array;
    if (this.numChannels === 2) {
      interleaved = this.interleave(channels[0], channels[1]);
    } else if (this.numChannels === 1) {
      // Mono - duplicate to stereo for consistency
      interleaved = this.interleave(channels[0], channels[0]);
      this.numChannels = 2;
    } else {
      // More than 2 channels - mix down to stereo
      const left = new Float32Array(audioBuffer.length);
      const right = new Float32Array(audioBuffer.length);
      for (let i = 0; i < audioBuffer.length; i++) {
        left[i] = channels[0][i];
        right[i] = channels[Math.min(1, channels.length - 1)][i];
      }
      interleaved = this.interleave(left, right);
      this.numChannels = 2;
    }

    // Create WAV file
    const wavData = this.writeWavHeader(interleaved);
    return new Blob([wavData], { type: "audio/wav" });
  }

  stopRecordingStreams() {
    if (this.recordingStream) {
      this.recordingStream.getTracks().forEach((track) => track.stop());
      this.recordingStream = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => track.stop());
      this.micStream = null;
    }

    if (this.processorNode) {
      this.processorNode.disconnect();
      this.processorNode = null;
    }

    if (this.muteGainNode) {
      this.muteGainNode.disconnect();
      this.muteGainNode = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.recorder = null;
  }

  registerGlobalHotkey() {
    if (!this.electron || !this.settings.muteHotkey) return;

    try {
      const remote = this.electron.remote || this.electron;
      const { globalShortcut } = remote;

      this.unregisterGlobalHotkey();

      const registered = globalShortcut.register(
        this.settings.muteHotkey,
        () => {
          this.toggleMute();
        },
      );

      if (!registered) {
        console.warn(
          `Failed to register global hotkey: ${this.settings.muteHotkey}`,
        );
      }
    } catch (err) {
      console.error("Error registering global hotkey:", err);
    }
  }

  unregisterGlobalHotkey() {
    if (!this.electron || !this.settings.muteHotkey) return;

    try {
      const remote = this.electron.remote || this.electron;
      const { globalShortcut } = remote;

      if (globalShortcut.isRegistered(this.settings.muteHotkey)) {
        globalShortcut.unregister(this.settings.muteHotkey);
      }
    } catch (err) {
      console.error("Error unregistering global hotkey:", err);
    }
  }

  async saveRecording(blob: Blob) {
    let buffer: Uint8Array;

    if (this.settings.outputFormat === "webm") {
      const duration = Date.now() - this.startTime;
      const fixedBlob = await new Promise<Blob>((resolve) => {
        fixWebmDuration(blob, duration, (fixed: Blob) => {
          resolve(fixed);
        });
      });
      const arrayBuffer = await fixedBlob.arrayBuffer();
      buffer = new Uint8Array(arrayBuffer);
    } else {
      const arrayBuffer = await blob.arrayBuffer();
      buffer = new Uint8Array(arrayBuffer);
    }

    const folderPath = this.settings.recordingsFolder;
    if (!(await this.app.vault.adapter.exists(folderPath))) {
      await this.app.vault.createFolder(folderPath);
    }

    const now = new Date();
    const timestamp = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")} ${now.getHours().toString().padStart(2, "0")}.${now.getMinutes().toString().padStart(2, "0")}.${now.getSeconds().toString().padStart(2, "0")}`;
    const extension = this.settings.outputFormat;
    const filename = `${folderPath}/Recording ${timestamp}.${extension}`;

    // @ts-ignore
    const file = await this.app.vault.createBinary(filename, buffer.buffer);

    // Save transcript if available
    if (this.transcriptionText.trim()) {
      const transcriptFilename = `${folderPath}/Recording ${timestamp} Transcript.md`;
      const transcriptContent = this.transcriptionText.trim();

      await this.app.vault.create(transcriptFilename, transcriptContent);
    }

    // Insert into active note if it was open when recording started
    if (this.activeFileAtStart) {
      let linkText = `\n![[${file.path}]]\n`;

      // Add transcript in collapsible format if available
      if (this.transcriptionText.trim()) {
        linkText += `\n> [!info]- Transcript\n`;
        linkText += `> ${this.transcriptionText.trim().replace(/\n/g, "\n> ")}\n`;
      }

      await this.app.vault.append(this.activeFileAtStart, linkText);
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  interleave(leftChannel: Float32Array, rightChannel: Float32Array) {
    const length = leftChannel.length + rightChannel.length;
    const result = new Float32Array(length);

    let inputIndex = 0;

    for (let index = 0; index < length; ) {
      result[index++] = leftChannel[inputIndex];
      result[index++] = rightChannel[inputIndex];
      inputIndex++;
    }
    return result;
  }

  convertFloat32ToInt16(buffer: Float32Array) {
    let l = buffer.length;
    const buf = new Int16Array(l);
    while (l--) {
      buf[l] = Math.min(1, Math.max(-1, buffer[l])) * 0x7fff;
    }
    return buf;
  }

  createWavFile(audioData: Float32Array, targetSampleRate: number): DataView {
    // Resample from current sample rate to target sample rate
    const ratio = this.sampleRate / targetSampleRate;
    const newLength = Math.round(audioData.length / ratio);
    const resampled = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const srcIndexFloor = Math.floor(srcIndex);
      const srcIndexCeil = Math.min(srcIndexFloor + 1, audioData.length - 1);
      const t = srcIndex - srcIndexFloor;

      // Linear interpolation
      resampled[i] =
        audioData[srcIndexFloor] * (1 - t) + audioData[srcIndexCeil] * t;
    }

    // Create WAV file (mono for transcription)
    const buffer = new ArrayBuffer(44 + resampled.length * 2);
    const view = new DataView(buffer);

    // WAV header
    this.writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + resampled.length * 2, true);
    this.writeString(view, 8, "WAVE");
    this.writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true); // Subchunk1Size
    view.setUint16(20, 1, true); // AudioFormat (PCM)
    view.setUint16(22, 1, true); // NumChannels (mono)
    view.setUint32(24, targetSampleRate, true); // SampleRate
    view.setUint32(28, targetSampleRate * 2, true); // ByteRate
    view.setUint16(32, 2, true); // BlockAlign
    view.setUint16(34, 16, true); // BitsPerSample
    this.writeString(view, 36, "data");
    view.setUint32(40, resampled.length * 2, true);

    // Write PCM data
    this.floatTo16BitPCM(view, 44, resampled);

    return view;
  }

  writeWavHeader(samples: Float32Array) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    this.writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    this.writeString(view, 8, "WAVE");
    this.writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, this.numChannels, true);
    view.setUint32(24, this.sampleRate, true);
    view.setUint32(28, this.sampleRate * 4, true);
    view.setUint16(32, this.numChannels * 2, true);
    view.setUint16(34, 16, true);
    this.writeString(view, 36, "data");
    view.setUint32(40, samples.length * 2, true);

    this.floatTo16BitPCM(view, 44, samples);

    return view;
  }

  floatTo16BitPCM(output: DataView, offset: number, input: Float32Array) {
    for (let i = 0; i < input.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }

  writeString(view: DataView, offset: number, string: string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}

class AudioRecorderSettingTab extends PluginSettingTab {
  plugin: AudioRecorderPlugin;

  constructor(app: App, plugin: AudioRecorderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    containerEl.createEl("h2", { text: "Settings for Audio Recorder" });

    new Setting(containerEl)
      .setName("Recordings Folder")
      .setDesc("Folder to save audio recordings in")
      .addText((text) =>
        text
          .setPlaceholder("Recordings")
          .setValue(this.plugin.settings.recordingsFolder)
          .onChange(async (value) => {
            this.plugin.settings.recordingsFolder = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Record Microphone")
      .setDesc("Record microphone audio along with system audio.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.recordMicrophone)
          .onChange(async (value) => {
            this.plugin.settings.recordMicrophone = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Microphone Source")
      .setDesc("Select the microphone to record.")
      .addDropdown(async (dropdown) => {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const audioInputs = devices.filter((d) => d.kind === "audioinput");

        audioInputs.forEach((device) => {
          dropdown.addOption(
            device.deviceId,
            device.label || `Microphone ${device.deviceId}`,
          );
        });

        dropdown.setValue(this.plugin.settings.selectedMicrophoneId);
        dropdown.onChange(async (value) => {
          this.plugin.settings.selectedMicrophoneId = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Output Format")
      .setDesc("Select the audio output format.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("webm", "WebM")
          .addOption("wav", "WAV")
          .setValue(this.plugin.settings.outputFormat)
          .onChange(async (value: "webm" | "wav") => {
            this.plugin.settings.outputFormat = value;
            await this.plugin.saveSettings();
          });
      });

    // Transcription Section
    containerEl.createEl("h3", { text: "Live Transcription" });

    new Setting(containerEl)
      .setName("Enable Live Transcription")
      .setDesc(
        "Enable live transcription during recording. Requires whisper.cpp to be installed locally.",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableTranscription)
          .onChange(async (value) => {
            this.plugin.settings.enableTranscription = value;
            await this.plugin.saveSettings();
          }),
      );

    // Whisper.cpp Executable Download Section
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const executableDir = path.join(
      (this.app.vault.adapter as any).getBasePath(),
      ".obsidian",
      "plugins",
      this.plugin.manifest.id,
      "bin",
    );
    const platform = os.platform();
    let executableName = "main";
    if (platform === "win32") {
      executableName = "main.exe";
    }
    const executablePath = path.join(executableDir, executableName);
    const executableExists = fs.existsSync(executablePath);

    const executableSetting = new Setting(containerEl)
      .setName("Whisper.cpp Executable")
      .setDesc(
        executableExists
          ? `Installed at: ${executablePath}`
          : "Not found. Click the button to download whisper.cpp automatically.",
      );

    executableSetting.addButton((button) => {
      button
        .setButtonText(
          executableExists ? "Re-download" : "Download whisper.cpp",
        )
        .setCta()
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Downloading...");

          const statusDiv = containerEl.createDiv();
          statusDiv.addClass("setting-item-description");
          statusDiv.style.marginTop = "0.5em";
          statusDiv.style.color = "#7c3aed";
          statusDiv.setText("Detecting platform and downloading...");

          try {
            await this.downloadWhisperCpp((status) => {
              statusDiv.setText(status);
            });

            statusDiv.style.color = "#10b981";
            statusDiv.setText("Download complete!");
            button.setButtonText("Re-download");

            // Update description
            executableSetting.setDesc(`Installed at: ${executablePath}`);

            // Update the whisper path setting
            this.plugin.settings.whisperCppPath = executablePath;
            await this.plugin.saveSettings();

            // Remove status after 3 seconds
            setTimeout(() => {
              statusDiv.remove();
            }, 3000);
          } catch (err) {
            statusDiv.style.color = "#ef4444";
            statusDiv.setText(`Error: ${err.message}`);
            button.setButtonText(
              executableExists ? "Re-download" : "Download whisper.cpp",
            );
          } finally {
            button.setDisabled(false);
          }
        });
    });

    // Whisper Model Selection
    new Setting(containerEl)
      .setName("Whisper Model")
      .setDesc(
        "Select which model to use. Smaller models are faster but less accurate. English-only models (.en) are faster for English.",
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("tiny", "Tiny (~75MB) - Fastest, least accurate")
          .addOption("tiny.en", "Tiny English (~75MB) - Fastest for English")
          .addOption("base", "Base (~150MB) - Balanced")
          .addOption("base.en", "Base English (~150MB) - Balanced for English")
          .addOption("small", "Small (~500MB) - Good accuracy")
          .addOption("small.en", "Small English (~500MB) - Good for English")
          .addOption("medium", "Medium (~1.5GB) - High accuracy")
          .addOption("medium.en", "Medium English (~1.5GB) - High for English")
          .addOption("large-v1", "Large v1 (~3GB) - Best accuracy")
          .addOption("large-v2", "Large v2 (~3GB) - Best accuracy")
          .addOption("large-v3", "Large v3 (~3GB) - Best accuracy, latest")
          .setValue(this.plugin.settings.whisperModel)
          .onChange(async (value) => {
            this.plugin.settings.whisperModel = value as any;
            await this.plugin.saveSettings();
            // Refresh display to show if selected model is downloaded
            this.display();
          });
      });

    // Whisper Model Download Section
    const modelDir = path.join(
      (this.app.vault.adapter as any).getBasePath(),
      ".obsidian",
      "plugins",
      this.plugin.manifest.id,
      "models",
    );
    const modelPath = path.join(
      modelDir,
      `ggml-${this.plugin.settings.whisperModel}.bin`,
    );
    const modelExists = fs.existsSync(modelPath);

    const modelSetting = new Setting(containerEl)
      .setName("Whisper Model")
      .setDesc(
        modelExists
          ? `Model installed at: ${modelPath}`
          : "Model not found. Click the button to download (~150MB).",
      );

    modelSetting.addButton((button) => {
      button
        .setButtonText(modelExists ? "Re-download Model" : "Download Model")
        .setCta()
        .onClick(async () => {
          button.setDisabled(true);
          button.setButtonText("Downloading...");

          const statusDiv = containerEl.createDiv();
          statusDiv.addClass("setting-item-description");
          statusDiv.style.marginTop = "0.5em";
          statusDiv.style.color = "#7c3aed";
          statusDiv.setText("Starting download...");

          try {
            // Delete existing model if re-downloading
            if (modelExists) {
              try {
                fs.unlinkSync(modelPath);
              } catch (err) {
                console.warn("Could not delete existing model:", err);
              }
            }

            // Download with progress updates
            await this.downloadModelWithProgress((progress) => {
              statusDiv.setText(`Downloading: ${progress}%`);
            });

            statusDiv.style.color = "#10b981";
            statusDiv.setText("Download complete!");
            button.setButtonText("Re-download Model");

            // Update description
            modelSetting.setDesc(`Model installed at: ${modelPath}`);

            // Remove status after 3 seconds
            setTimeout(() => {
              statusDiv.remove();
            }, 3000);
          } catch (err) {
            statusDiv.style.color = "#ef4444";
            statusDiv.setText(`Error: ${err.message}`);
            button.setButtonText(
              modelExists ? "Re-download Model" : "Download Model",
            );
          } finally {
            button.setDisabled(false);
          }
        });
    });

    const instructionsDiv = containerEl.createDiv();
    instructionsDiv.addClass("setting-item-description");
    instructionsDiv.style.marginBottom = "1em";
    instructionsDiv.style.padding = "0.5em";
    instructionsDiv.style.backgroundColor = "var(--background-secondary)";
    instructionsDiv.style.borderRadius = "4px";
    instructionsDiv.innerHTML = `
      <strong>📝 Setup Instructions:</strong><br>
      1. Click "Download whisper.cpp" above<br>
      2. Click "Download Model" below<br>
      3. Enable transcription and start recording!
    `;

    // Hotkeys Section
    containerEl.createEl("h3", { text: "Hotkeys" });

    new Setting(containerEl)
      .setName("Global Mute Hotkey")
      .setDesc(
        "Set a system-wide hotkey to toggle microphone muting (works even when Obsidian isn't focused). " +
          "Uses Electron's accelerator format. Examples: 'CommandOrControl+Shift+M', 'Alt+M', 'Ctrl+Shift+Space'. " +
          "Changes take effect when starting a new recording.",
      )
      .addText((text) =>
        text
          .setPlaceholder("CommandOrControl+Shift+M")
          .setValue(this.plugin.settings.muteHotkey)
          .onChange(async (value) => {
            this.plugin.settings.muteHotkey = value;
            await this.plugin.saveSettings();
          }),
      );

    const hotkeyDesc = containerEl.createDiv();
    hotkeyDesc.addClass("setting-item-description");
    hotkeyDesc.setText(
      "You can also use Obsidian's built-in hotkeys (Settings → Hotkeys → 'Toggle Microphone Mute'), " +
        "but those only work when Obsidian is focused.",
    );
    hotkeyDesc.style.marginBottom = "1em";
  }

  async downloadWhisperCpp(
    statusCallback: (status: string) => void,
  ): Promise<string> {
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const https = require("https");

    const platform = os.platform();
    const arch = os.arch();

    // Create bin directory in plugin folder
    const binDir = path.join(
      (this.app.vault.adapter as any).getBasePath(),
      ".obsidian",
      "plugins",
      this.plugin.manifest.id,
      "bin",
    );
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }

    let executableName = "main";
    let downloadUrl = "";

    // Download official whisper.cpp binaries
    if (platform === "win32") {
      executableName = "main.exe";
      if (arch === "x64") {
        downloadUrl =
          "https://github.com/ggerganov/whisper.cpp/releases/download/v1.8.2/whisper-bin-x64.zip";
      } else {
        // 32-bit Windows
        executableName = "main.exe";
        downloadUrl =
          "https://github.com/ggerganov/whisper.cpp/releases/download/v1.8.2/whisper-bin-Win32.zip";
      }
    } else if (platform === "darwin") {
      throw new Error(
        "Automatic download not available for macOS. Please install via Homebrew: brew install whisper-cpp",
      );
    } else if (platform === "linux") {
      throw new Error(
        "Automatic download not available for Linux. Please build from source: https://github.com/ggerganov/whisper.cpp",
      );
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    const executablePath = path.join(binDir, executableName);

    statusCallback("Downloading whisper.cpp...");

    return new Promise((resolve, reject) => {
      const zipPath = path.join(binDir, "whisper.zip");
      const file = fs.createWriteStream(zipPath);
      let downloadedBytes = 0;
      let totalBytes = 0;

      file.on("error", (err: Error) => {
        console.error("File write stream error:", err);
        reject(err);
      });

      // Recursive function to follow all redirects
      const followRedirects = (url: string, depth: number = 0): void => {
        if (depth > 10) {
          reject(new Error("Too many redirects (>10)"));
          return;
        }

        https
          .get(url, (response: any) => {
            // Check if this is a redirect
            if (
              response.statusCode === 301 ||
              response.statusCode === 302 ||
              response.statusCode === 303 ||
              response.statusCode === 307 ||
              response.statusCode === 308
            ) {
              const redirectUrl = response.headers.location;
              response.resume(); // Consume response to free memory
              followRedirects(redirectUrl, depth + 1);
            } else if (response.statusCode === 200) {
              // Success - start actual download
              totalBytes = parseInt(
                response.headers["content-length"] || "0",
                10,
              );

              response.on("data", (chunk: Buffer) => {
                downloadedBytes += chunk.length;
                const progress = Math.floor(
                  (downloadedBytes / totalBytes) * 100,
                );
                statusCallback(`Downloading whisper.cpp: ${progress}%`);
              });

              response.on("error", (err: Error) => {
                console.error("Response stream error:", err);
                file.close();
                fs.unlink(zipPath, () => {});
                reject(err);
              });

              response.pipe(file);

              file.on("finish", () => {
                file.close(() => {
                  // Validate downloaded file
                  const stats = fs.statSync(zipPath);

                  if (stats.size === 0) {
                    reject(new Error("Downloaded file is empty"));
                    return;
                  }

                  if (stats.size < 1000) {
                    reject(
                      new Error(
                        "Downloaded file appears to be invalid or corrupted",
                      ),
                    );
                    return;
                  }

                  statusCallback("Extracting...");

                  try {
                    // Use Node's built-in zlib for extraction
                    const { execSync } = require("child_process");

                    // Use PowerShell to extract on Windows
                    if (platform === "win32") {
                      // First try to use .NET method with proper error handling
                      // Convert paths to forward slashes for PowerShell
                      const zipPathPS = zipPath.replace(/\\/g, "/");
                      const binDirPS = binDir.replace(/\\/g, "/");

                      // Use simple one-liner command (multiline scripts have issues with execSync)
                      try {
                        const command = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${zipPathPS}', '${binDirPS}'); Write-Output 'Done'"`;
                        execSync(command, {
                          encoding: "utf8",
                        });
                      } catch (e: any) {
                        // Fallback to Expand-Archive if .NET method fails
                        try {
                          const psCommand = `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${binDir}' -Force`;
                          execSync(
                            `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCommand}"`,
                            {
                              encoding: "utf8",
                            },
                          );
                        } catch (e2: any) {
                          throw new Error(
                            `Failed to extract archive: ${e2.message}`,
                          );
                        }
                      }
                    } else {
                      // Use unzip command on Unix-like systems
                      execSync(`unzip -o "${zipPath}" -d "${binDir}"`, {
                        encoding: "utf8",
                      });
                    }

                    // Find the main executable in extracted files
                    let extractedFiles = fs.readdirSync(binDir);
                    let found = false;

                    // Check if extraction failed - only zip file present

                    if (
                      extractedFiles.length === 1 &&
                      extractedFiles[0] === "whisper.zip"
                    ) {
                      console.error(
                        "Extraction appears to have failed - only zip file present",
                      );
                      throw new Error(
                        "Failed to extract whisper.cpp archive. The download may be corrupted or the archive format is unsupported.",
                      );
                    }

                    // Check if there's a nested zip file that needs extraction
                    for (const extractedFile of extractedFiles) {
                      if (
                        extractedFile.endsWith(".zip") &&
                        extractedFile !== "whisper.zip"
                      ) {
                        const nestedZipPath = path.join(binDir, extractedFile);
                        const tempExtractDir = path.join(
                          binDir,
                          "temp_extract",
                        );

                        // Create temp directory
                        if (!fs.existsSync(tempExtractDir)) {
                          fs.mkdirSync(tempExtractDir, { recursive: true });
                        }

                        // Use .NET method for nested extraction with error handling
                        const nestedZipPathPS = nestedZipPath.replace(
                          /\\/g,
                          "/",
                        );
                        const tempExtractDirPS = tempExtractDir.replace(
                          /\\/g,
                          "/",
                        );

                        // Use simple one-liner for nested extraction
                        try {
                          const command = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${nestedZipPathPS}', '${tempExtractDirPS}'); Write-Output 'Done'"`;
                          execSync(command, {
                            encoding: "utf8",
                          });
                        } catch (e: any) {
                          // Try fallback
                          try {
                            const psCommand2 = `Expand-Archive -LiteralPath '${nestedZipPath}' -DestinationPath '${tempExtractDir}' -Force`;
                            execSync(
                              `powershell -NoProfile -ExecutionPolicy Bypass -Command "${psCommand2}"`,
                              {
                                encoding: "utf8",
                              },
                            );
                          } catch (e2: any) {
                            throw new Error(
                              `Failed to extract nested archive: ${e2.message}`,
                            );
                          }
                        }

                        // Move all files from temp dir to binDir
                        const tempFiles = fs.readdirSync(tempExtractDir);
                        for (const tempFile of tempFiles) {
                          const srcPath = path.join(tempExtractDir, tempFile);
                          const destPath = path.join(binDir, tempFile);
                          if (fs.existsSync(destPath)) {
                            // Remove existing file/dir
                            if (fs.statSync(destPath).isDirectory()) {
                              fs.rmSync(destPath, { recursive: true });
                            } else {
                              fs.unlinkSync(destPath);
                            }
                          }
                          fs.renameSync(srcPath, destPath);
                        }

                        // Clean up
                        fs.rmdirSync(tempExtractDir);
                        fs.unlinkSync(nestedZipPath);

                        // Re-read the directory
                        extractedFiles = fs.readdirSync(binDir);
                        break;
                      }
                    }

                    for (const extractedFile of extractedFiles) {
                      if (
                        extractedFile === "main.exe" ||
                        extractedFile === "main" ||
                        extractedFile === "whisper.exe" ||
                        extractedFile === "whisper"
                      ) {
                        const extractedPath = path.join(binDir, extractedFile);
                        if (extractedPath !== executablePath) {
                          fs.renameSync(extractedPath, executablePath);
                        }
                        found = true;
                        break;
                      }
                    }

                    // Search in subdirectories if not found
                    if (!found) {
                      for (const extractedFile of extractedFiles) {
                        const fullPath = path.join(binDir, extractedFile);
                        try {
                          if (fs.statSync(fullPath).isDirectory()) {
                            const subFiles = fs.readdirSync(fullPath);

                            // Check if this directory contains whisper binaries
                            const hasWhisperCli =
                              subFiles.includes("whisper-cli.exe");
                            const hasMainExe = subFiles.includes("main.exe");

                            if (hasWhisperCli || hasMainExe) {
                              // Copy all files from Release directory to bin directory
                              // This ensures DLLs are in the same directory as the executable
                              for (const subFile of subFiles) {
                                const srcPath = path.join(fullPath, subFile);
                                const destPath = path.join(binDir, subFile);

                                try {
                                  if (fs.statSync(srcPath).isFile()) {
                                    fs.copyFileSync(srcPath, destPath);
                                  }
                                } catch (copyErr: any) {
                                  console.error(
                                    `Failed to copy ${subFile}:`,
                                    copyErr.message,
                                  );
                                }
                              }

                              // Use whisper-cli.exe if available (main.exe is deprecated)
                              const preferredExe = hasWhisperCli
                                ? "whisper-cli.exe"
                                : "main.exe";
                              const srcExe = path.join(binDir, preferredExe);

                              // Rename to expected executable name
                              if (
                                fs.existsSync(srcExe) &&
                                srcExe !== executablePath
                              ) {
                                fs.renameSync(srcExe, executablePath);
                              }

                              // Clean up Release directory after copying
                              try {
                                fs.rmSync(fullPath, {
                                  recursive: true,
                                  force: true,
                                });
                              } catch (cleanupErr: any) {
                                // Silently ignore cleanup errors
                              }

                              found = true;
                              break;
                            }
                          }
                        } catch (e: any) {
                          console.error(
                            `Error checking ${extractedFile}:`,
                            e.message,
                          );
                        }
                      }
                    }

                    // Make executable on Unix-like systems
                    if (platform !== "win32") {
                      fs.chmodSync(executablePath, 0o755);
                    }

                    // Clean up zip
                    try {
                      fs.unlinkSync(zipPath);
                    } catch (e) {
                      // Ignore cleanup errors
                    }

                    if (found) {
                      resolve(executablePath);
                    } else {
                      reject(
                        new Error(
                          "Could not find main executable in downloaded archive",
                        ),
                      );
                    }
                  } catch (err) {
                    reject(err);
                  }
                });
              });
            } else {
              // Unexpected status code
              console.error(
                `[Depth ${depth}] Unexpected status: ${response.statusCode}`,
              );
              reject(
                new Error(
                  `Download failed with status: ${response.statusCode}`,
                ),
              );
            }
          })
          .on("error", (err: Error) => {
            console.error(`[Depth ${depth}] Request error:`, err);
            fs.unlink(zipPath, () => {});
            reject(err);
          });
      };

      // Start the download with redirect following
      followRedirects(downloadUrl);
    });
  }

  async downloadModelWithProgress(
    progressCallback: (progress: string) => void,
  ): Promise<string> {
    const fs = require("fs");
    const path = require("path");
    const https = require("https");

    // Create models directory in plugin folder
    const modelDir = path.join(
      (this.app.vault.adapter as any).getBasePath(),
      ".obsidian",
      "plugins",
      this.plugin.manifest.id,
      "models",
    );
    if (!fs.existsSync(modelDir)) {
      fs.mkdirSync(modelDir, { recursive: true });
    }

    const modelName = `ggml-${this.plugin.settings.whisperModel}.bin`;
    const modelPath = path.join(modelDir, modelName);
    const modelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelName}`;

    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(modelPath);
      let downloadedBytes = 0;
      let totalBytes = 0;
      let lastReportedProgress = 0;

      https
        .get(modelUrl, (response: any) => {
          if (response.statusCode === 302 || response.statusCode === 301) {
            // Handle redirect
            https
              .get(response.headers.location, (redirectResponse: any) => {
                totalBytes = parseInt(
                  redirectResponse.headers["content-length"],
                  10,
                );

                redirectResponse.on("data", (chunk: Buffer) => {
                  downloadedBytes += chunk.length;
                  const progress = Math.floor(
                    (downloadedBytes / totalBytes) * 100,
                  );

                  // Report progress every 1%
                  if (progress > lastReportedProgress) {
                    lastReportedProgress = progress;
                    progressCallback(progress.toString());
                  }
                });

                redirectResponse.pipe(file);

                file.on("finish", () => {
                  file.close();
                  resolve(modelPath);
                });
              })
              .on("error", (err: Error) => {
                fs.unlink(modelPath, () => {});
                reject(err);
              });
          } else {
            totalBytes = parseInt(response.headers["content-length"], 10);

            response.on("data", (chunk: Buffer) => {
              downloadedBytes += chunk.length;
              const progress = Math.floor((downloadedBytes / totalBytes) * 100);

              // Report progress every 1%
              if (progress > lastReportedProgress) {
                lastReportedProgress = progress;
                progressCallback(progress.toString());
              }
            });

            response.pipe(file);

            file.on("finish", () => {
              file.close();
              resolve(modelPath);
            });
          }
        })
        .on("error", (err: Error) => {
          fs.unlink(modelPath, () => {});
          reject(err);
        });
    });
  }
}
