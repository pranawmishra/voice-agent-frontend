import { Fragment, useCallback, useEffect, useRef, useState, lazy, Suspense } from "react";
import Transcript from "./features/voice/Transcript.jsx";
import { useDeepgram } from "../context/DeepgramContextProvider";
import { useMicrophone } from "../context/MicrophoneContextProvider.jsx";
import { EventType, useVoiceBot, VoiceBotStatus } from "../context/VoiceBotContextProvider";
import { createAudioBuffer, playAudioBuffer } from "../utils/audioUtils";
import { sendSocketMessage, sendMicToSocket } from "../utils/deepgramUtils";
import { isMobile } from "react-device-detect";
import { usePrevious } from "@uidotdev/usehooks";
import { useStsQueryParams } from "../hooks/UseStsQueryParams";
import RateLimited from "./RateLimited.tsx";

const AnimationManager = lazy(() => import("./layout/AnimationManager.tsx"));

export const App = ({
  defaultStsConfig,
  onMessageEvent = () => {},
  requiresUserActionToInitialize = false,
  className = "",
}) => {
  const {
    status,
    messages,
    addVoiceBotMessage,
    addBehindTheScenesEvent,
    clearMessages,
    isWaitingForUserVoiceAfterSleep,
    toggleSleep,
    startListening,
    startSpeaking,
  } = useVoiceBot();
  const {
    setupMicrophone,
    microphone,
    microphoneState,
    processor,
    microphoneAudioContext,
    startMicrophone,
    stopMicrophone,
  } = useMicrophone();
  const {
    socket,
    connectToDeepgram,
    socketState,
    rateLimited,
    disconnectFromDeepgram,
    sessionExpired,
  } = useDeepgram();
  const { voice, instructions, applyParamsToConfig } = useStsQueryParams();
  const audioContext = useRef(null);
  const agentVoiceAnalyser = useRef(null);
  const userVoiceAnalyser = useRef(null);
  const startTimeRef = useRef(-1);
  // Track whether we've already sent initial Settings on this logical session
  const hasSentInitialSettings = useRef(false);
  const [isInitialized, setIsInitialized] = useState(
    requiresUserActionToInitialize ? false : null,
  );
  const previousVoice = usePrevious(voice);
  const previousInstructions = usePrevious(instructions);
  const scheduledAudioSources = useRef([]);
  const [isRootPath, setIsRootPath] = useState(window.location.pathname === "/");
  const [isConnected, setIsConnected] = useState(false);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState({ user: "", assistant: "" });

  // AUDIO MANAGEMENT
  /**
   * Initialize the audio context for managing and playing audio. (just for TTS playback; user audio input logic found in Microphone Context Provider)
   */
  useEffect(() => {
    if (!audioContext.current) {
      audioContext.current = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: "interactive",
        sampleRate: 24000,
      });
      agentVoiceAnalyser.current = audioContext.current.createAnalyser();
      agentVoiceAnalyser.current.fftSize = 2048;
      agentVoiceAnalyser.current.smoothingTimeConstant = 0.96;
    }
  }, []);

  /**
   * Callback to handle audio data processing and playback.
   * Converts raw audio into an AudioBuffer and plays the processed audio through the web audio context
   */
  const bufferAudio = useCallback((data) => {
    const audioBuffer = createAudioBuffer(audioContext.current, data);
    if (!audioBuffer) return;
    scheduledAudioSources.current.push(
      playAudioBuffer(audioContext.current, audioBuffer, startTimeRef, agentVoiceAnalyser.current),
    );
  }, []);

  const clearAudioBuffer = () => {
    scheduledAudioSources.current.forEach((source) => source.stop());
    scheduledAudioSources.current = [];
  };

  // MICROPHONE AND SOCKET MANAGEMENT
  useEffect(() => {
    console.log("Initial setup - calling setupMicrophone()");
    // Only setup if not already in progress
    if (microphoneState === null) {
      setupMicrophone();
    }
  }, [microphoneState]);

  useEffect(() => {
    console.log("Microphone state changed:", {
      microphoneState,
      hasSocket: !!socket,
      hasConfig: !!defaultStsConfig,
    });
    if (microphoneState === 1 && socket && defaultStsConfig) {
      const onOpen = () => {
        console.log("Socket opened - ready for connection");
        // Don't send settings or start microphone automatically
        // This will be done when user clicks connect
      };

      socket.addEventListener("open", onOpen);
      return () => {
        socket.removeEventListener("open", onOpen);
        microphone.ondataavailable = null;
      };
    }
  }, [microphone, socket, microphoneState, defaultStsConfig, isRootPath, isConnected]);

  useEffect(() => {
    console.log("Checking processor setup:", {
      hasMicrophone: !!microphone,
      hasSocket: !!socket,
      microphoneState,
      socketState,
      isConnected,
    });
    if (!microphone) return;
    if (!socket) return;
    if (microphoneState !== 2) return;
    if (socketState !== 1) return;
    if (!isConnected) return; // Only setup processor if user has connected

    // Only set up audio processor after user has connected and Settings has been sent
    const setupProcessor = () => {
      console.log("Setting up audio processor after user connected");
      processor.onaudioprocess = sendMicToSocket(socket);
    };

    // Add a small delay to ensure Settings is processed
    setTimeout(setupProcessor, 1500);
  }, [microphone, socket, microphoneState, socketState, processor, isConnected]);

  /**
   * Create AnalyserNode for user microphone audio context.
   * Exposes audio time / frequency data which is used in the
   * AnimationManager to scale the animations in response to user/agent voice
   */
  useEffect(() => {
    if (microphoneAudioContext) {
      userVoiceAnalyser.current = microphoneAudioContext.createAnalyser();
      userVoiceAnalyser.current.fftSize = 2048;
      userVoiceAnalyser.current.smoothingTimeConstant = 0.96;
      microphone.connect(userVoiceAnalyser.current);
    }
  }, [microphoneAudioContext, microphone]);

  /**
   * Handles incoming WebSocket messages. Differentiates between ArrayBuffer data and other data types (basically just string type).
   * */
  const onMessage = useCallback(
    async (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Only play audio if connected and not sleeping
        if (
          isConnected &&
          status !== VoiceBotStatus.SLEEPING &&
          !isWaitingForUserVoiceAfterSleep.current
        ) {
          bufferAudio(event.data); // Process the ArrayBuffer data to play the audio
        }
      } else {
        // Log the raw data so we can see any error frames from Deepgram
        console.log("Raw WebSocket data:", event.data);

        let message;
        try {
          message = JSON.parse(event.data);
        } catch (e) {
          console.error("Failed to parse WebSocket message as JSON:", event.data, e);
          return;
        }

        console.log("Received WebSocket message:", message);
        onMessageEvent(message);

        const { type, role, content, functions } = message;

        if (type === "ConversationText") {
          if (role === "user") {
            setLiveTranscript((prev) => ({ ...prev, user: content }));
          } else if (role === "assistant") {
            setLiveTranscript((prev) => ({ ...prev, assistant: content }));
          }
        } else if (role === "user") {
          setIsUserSpeaking(false);
          setLiveTranscript({ user: "", assistant: "" });
          addVoiceBotMessage({ user: content });
        } else if (role === "assistant") {
          setLiveTranscript((prev) => ({ ...prev, assistant: content }));
          startSpeaking();
          addVoiceBotMessage({ assistant: content });
        } else if (type === EventType.USER_STARTED_SPEAKING) {
          setIsUserSpeaking(true);
          isWaitingForUserVoiceAfterSleep.current = false;
          startListening();
          clearAudioBuffer();
        } else if (type === EventType.AGENT_AUDIO_DONE) {
          startListening();
        } else if (type === "FunctionCallRequest") {
          console.log("Received FunctionCallRequest:", message);
          if (functions && functions.length > 0) {
            try {
              const response = await fetch(
                `${import.meta.env.VITE_BACKEND_URL}/api/voice/function-calls`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ functions }),
                },
              );

              const data = await response.json();
              // Backend may return either an array of responses or an object { responses: [...] }.
              const responses = Array.isArray(data) ? data : data.responses || [];

              if (responses && responses.length > 0) {
                responses.forEach((response) => {
                  console.log("Sending function response:", response);
                  sendSocketMessage(socket, response);
                });
              }
            } catch (error) {
              console.error("Error handling function calls:", error);
            }
          } else {
            console.error("No functions provided in FunctionCallRequest");
          }
        }
      }
    },
    [
      isConnected,
      status,
      bufferAudio,
      onMessageEvent,
      addVoiceBotMessage,
      startListening,
      startSpeaking,
      socket,
      isWaitingForUserVoiceAfterSleep,
    ],
  );

  /**
   * Sets up a WebSocket message event listener to handle incoming messages through the 'onMessage' callback.
   */
  useEffect(() => {
    if (socket) {
      socket.addEventListener("message", onMessage);
      return () => socket.removeEventListener("message", onMessage);
    }
  }, [socket, onMessage]);

  useEffect(() => {
    if (previousVoice && previousVoice !== voice && socket && socketState === 1) {
      // Match DGMessage type: UpdateSpeak expects a `provider` object
      sendSocketMessage(socket, {
        type: "UpdateSpeak",
        provider: {
          type: "deepgram",
          model: voice,
        },
      });
    }
  }, [voice, socket, socketState, previousVoice]);

  const handleUpdateInstructions = useCallback(
    (instructions) => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        sendSocketMessage(socket, {
          type: "UpdateInstructions",
          prompt: `${defaultStsConfig.agent.think.prompt}\n${instructions}`,
        });
      }
    },
    [socket, defaultStsConfig],
  );

  const handleVoiceBotAction = () => {
    if (requiresUserActionToInitialize && !isInitialized) {
      setIsInitialized(true);
    }

    if (status !== VoiceBotStatus.NONE) {
      toggleSleep();
    }
  };

  const maybeRecordBehindTheScenesEvent = (serverMsg) => {
    switch (serverMsg.type) {
      case EventType.SETTINGS_APPLIED:
        addBehindTheScenesEvent({
          type: EventType.SETTINGS_APPLIED,
        });
        break;
      case EventType.USER_STARTED_SPEAKING:
        if (status === VoiceBotStatus.SPEAKING) {
          addBehindTheScenesEvent({
            type: "Interruption",
          });
        }
        addBehindTheScenesEvent({
          type: EventType.USER_STARTED_SPEAKING,
        });
        break;
      case EventType.AGENT_STARTED_SPEAKING:
        addBehindTheScenesEvent({
          type: EventType.AGENT_STARTED_SPEAKING,
        });
        break;
      case EventType.CONVERSATION_TEXT: {
        const role = serverMsg.role;
        const content = serverMsg.content;
        addBehindTheScenesEvent({
          type: EventType.CONVERSATION_TEXT,
          role: role,
          content: content,
        });
        break;
      }
      case EventType.END_OF_THOUGHT:
        addBehindTheScenesEvent({
          type: EventType.END_OF_THOUGHT,
        });
        break;
    }
  };

  const handleInitialize = async () => {
    if (!isInitialized) {
      setIsInitialized(true);
      await setupMicrophone();
    }
  };

  const handleConnect = async () => {
    try {
      console.log("Connecting to Deepgram...");
      await connectToDeepgram();
      console.log("Connection initiated");
    } catch (error) {
      console.error("Failed to connect:", error);
    }
  };

  useEffect(() => {
    // Only send initial Settings once per WebSocket connection.
    if (
      isConnected &&
      socket &&
      socket.readyState === WebSocket.OPEN &&
      defaultStsConfig &&
      !hasSentInitialSettings.current
    ) {
      console.log("Socket ready and user connected - sending Settings message");

      // Normalize the config coming from the backend to match the Deepgram Agent API spec.
      // In particular, ensure that `agent.speak` only contains a `provider` field and move
      // any greeting into `agent.greeting`.
      const baseAgent = defaultStsConfig.agent ?? {};
      const speakConfig = baseAgent.speak ?? {};

      const normalizedConfig = {
        type: "Settings",
        experimental: defaultStsConfig.experimental ?? false,
        mip_opt_out: defaultStsConfig.mip_opt_out ?? false,
        audio: defaultStsConfig.audio,
        agent: {
          ...baseAgent,
          speak: {
            provider: speakConfig.provider ?? speakConfig,
          },
          think: {
            ...baseAgent.think,
            prompt: `${baseAgent.think?.prompt ?? ""}\n${instructions}`,
          },
          // Prefer an explicit agent.greeting, otherwise fall back to speak.greeting if present
          greeting: baseAgent.greeting ?? speakConfig.greeting,
        },
      };

      sendSocketMessage(socket, normalizedConfig);
      hasSentInitialSettings.current = true;

      // Wait for Settings to be processed before starting microphone
      setTimeout(() => {
        console.log("Starting microphone after user connected");
        startMicrophone();
        if (isRootPath) {
          startSpeaking(true);
          isWaitingForUserVoiceAfterSleep.current = false;
        } else {
          startListening(true);
        }
      }, 1000);
    }
  }, [isConnected, socket, socketState, defaultStsConfig, instructions, isRootPath]);

  const handleDisconnect = useCallback(() => {
    console.log("Disconnecting from Deepgram");
    hasSentInitialSettings.current = false; // Allow Settings to be resent on next connection
    clearMessages();
    setLiveTranscript({ user: "", assistant: "" });
    stopMicrophone();
    disconnectFromDeepgram();
    if (status !== VoiceBotStatus.SLEEPING) {
      toggleSleep();
    }
    console.log("Disconnected successfully");
  }, [clearMessages, disconnectFromDeepgram, stopMicrophone, status, toggleSleep]);

  useEffect(() => {
    if (sessionExpired) {
      console.log("Session expired, handling full disconnect.");
      handleDisconnect();
    }
  }, [sessionExpired, handleDisconnect]);

  // Keep local isConnected flag in sync with underlying socket state, and reset
  // Settings sent flag whenever the socket is not actively connected.
  useEffect(() => {
    const connectedNow = socketState === 1;
    setIsConnected(connectedNow);
    if (!connectedNow) {
      hasSentInitialSettings.current = false;
    }
  }, [socketState]);

  if (requiresUserActionToInitialize && !isInitialized) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <button
          onClick={handleInitialize}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          Start Voice Assistant
        </button>
      </div>
    );
  }

  if (rateLimited) {
    return <RateLimited />;
  }

  // MAIN UI
  return (
    <div className={className}>
      <h1 className="text-2xl font-bold text-center py-4">Friday - Voice Assistant</h1>
      <Suspense fallback={<div>Loading...</div>}>
        <AnimationManager
          agentVoiceAnalyser={agentVoiceAnalyser.current}
          userVoiceAnalyser={userVoiceAnalyser.current}
          onOrbClick={toggleSleep}
        />
        {/* Status Indicator */}
        <div className="text-center mt-4 mb-4">
          {isConnected && status === VoiceBotStatus.SPEAKING && (
            <p className="text-gray-400">Agent is speaking...</p>
          )}
          {isConnected && isUserSpeaking && (
            <p className="text-gray-400">You are speaking...</p>
          )}
          {isConnected && status === VoiceBotStatus.LISTENING && (
            <p className="text-gray-400">Listening...</p>
          )}
          {isConnected && status === VoiceBotStatus.THINKING && (
            <p className="text-gray-400">Agent is thinking...</p>
          )}
          {socketState === -1 && <p className="text-gray-400">Ready to connect</p>}
        </div>
        {!microphone ? (
          <div className="text-base text-gray-400 text-center w-full">Loading microphone...</div>
        ) : (
          <Fragment>
            {socketState === 0 && (
              <div className="text-base text-gray-400 text-center w-full">
                Connecting to Friday...
              </div>
            )}
            {socketState > 0 && status === VoiceBotStatus.SLEEPING && (
              <div className="text-xl flex flex-col items-center justify-center">
                <div className="text-gray-400 text-sm">
                  I've stopped listening. {isMobile ? "Tap" : "Click"} the orb to resume.
                </div>
              </div>
            )}

            <div className="w-full max-w-4xl mx-auto mt-8">
              {/* Connect/Disconnect Button */}
              <div className="flex justify-center mb-6">
                {!isConnected ? (
                  <button
                    onClick={handleConnect}
                    disabled={microphoneState < 1 || socketState === 0} // Disable while connecting
                    className="px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed font-semibold"
                  >
                    {microphoneState < 1
                      ? "Setting up microphone..."
                      : socketState === 0
                        ? "Connecting to Friday..."
                        : "Connect to Friday"}
                  </button>
                ) : (
                  <button
                    onClick={handleDisconnect}
                    className="px-6 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 font-semibold"
                  >
                    Disconnect Agent
                  </button>
                )}
              </div>
            </div>

            {/* Transcript Section */}
            <div className="text-sm md:text-base mt-2 flex flex-col items-center text-gray-200 overflow-y-auto">
              {(messages.length > 0 || liveTranscript.user || liveTranscript.assistant) && (
                <Transcript liveTranscript={liveTranscript} />
              )}
            </div>
          </Fragment>
        )}
      </Suspense>
    </div>
  );
};
