import { type ReactNode, createContext, useContext, useState, useRef, useEffect } from "react";
import { sendKeepAliveMessage } from "../utils/deepgramUtils";

enum SocketState {
  Unstarted = -1,
  Connecting = 0,
  Connected = 1,
  Failed = 2,
  Closed = 3,
}

interface Context {
  socket: null | WebSocket;
  socketState: SocketState;
  rateLimited: boolean;
  sessionExpired: boolean;
  connectToDeepgram: () => Promise<void>;
  disconnectFromDeepgram: () => void;
}

const defaultContext: Context = {
  socket: null,
  socketState: SocketState.Unstarted,
  rateLimited: false,
  sessionExpired: false,
  connectToDeepgram: async () => {},
  disconnectFromDeepgram: () => {},
};

const DeepgramContext = createContext<Context>(defaultContext);

const DeepgramContextProvider = ({ children }: { children: ReactNode }) => {
  const [socket, setSocket] = useState(defaultContext.socket);
  const [socketState, setSocketState] = useState<SocketState>(defaultContext.socketState);
  const [rateLimited, setRateLimited] = useState<boolean>(defaultContext.rateLimited);
  const [sessionExpired, setSessionExpired] = useState<boolean>(defaultContext.sessionExpired);

  const keepAlive = useRef<NodeJS.Timeout | null>(null);
  const autoDisconnectTimer = useRef<NodeJS.Timeout | null>(null);

  const connectToDeepgram = async () => {
    // Clear any existing auto-disconnect timer
    if (autoDisconnectTimer.current) {
      clearTimeout(autoDisconnectTimer.current);
      autoDisconnectTimer.current = null;
    }

    setSessionExpired(false);

    // If there's an existing socket, close it properly
    if (socket) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      setSocket(null);
    }

    // Clear any existing keepalive
    if (keepAlive.current) {
      clearInterval(keepAlive.current);
      keepAlive.current = null;
    }

    setSocketState(SocketState.Connecting);
    console.log("Attempting to connect to Deepgram...");

    try {
      // Get the API key from your server instead
      const response = await fetch(`${import.meta.env.VITE_BACKEND_URL}/api/deepgram/api-key`, {
        headers: {
          'ngrok-skip-browser-warning': 'true'
        }
      });
      const { access_token } = await response.json();
      // console.log("response", response);

      const newSocket = new WebSocket("wss://agent.deepgram.com/v1/agent/converse", [
          "Bearer",
          // "Bearer": import.meta.env.VITE_DEEPGRAM_API_KEY,
          access_token,
      ]);

      const onOpen = () => {
        console.log("WebSocket connected successfully");
        setSocketState(SocketState.Connected);
        setRateLimited(false);

        // Clear any existing keepalive interval
        if (keepAlive.current) {
          clearInterval(keepAlive.current);
        }

        keepAlive.current = setInterval(sendKeepAliveMessage(newSocket), 60000);

        // Start the 2-minute auto-disconnect timer
        console.log("Starting 2-minute auto-disconnect timer.");
        autoDisconnectTimer.current = setTimeout(() => {
          console.log("2-minute session limit reached. Triggering auto-disconnect.");
          setSessionExpired(true);
        }, 120000); // 2 minutes
      };

      const onError = (err: Event) => {
        setSocketState(SocketState.Failed);
        console.error("WebSocket error:", err);
      };

      const onClose = (event: CloseEvent) => {
        console.log("WebSocket closed", { code: event.code, reason: event.reason, wasClean: event.wasClean });

        if (keepAlive.current) {
          clearInterval(keepAlive.current);
          keepAlive.current = null;
        }

        if (autoDisconnectTimer.current) {
          clearTimeout(autoDisconnectTimer.current);
          autoDisconnectTimer.current = null;
        }

        setSocketState(SocketState.Closed);
      };

      const onMessage = () => {
        // console.info("message", e);
      };

      newSocket.binaryType = "arraybuffer";
      newSocket.addEventListener("open", onOpen);
      newSocket.addEventListener("error", onError);
      newSocket.addEventListener("close", onClose);
      newSocket.addEventListener("message", onMessage);

      setSocket(newSocket);
    } catch (error) {
      console.error("Failed to create WebSocket:", error);
      setSocketState(SocketState.Failed);

      // Leave socket in failed state; caller UI can decide whether to retry.
    }
  };

  const disconnectFromDeepgram = () => {
    if (keepAlive.current) {
      clearInterval(keepAlive.current);
      keepAlive.current = null;
    }

    if (autoDisconnectTimer.current) {
      clearTimeout(autoDisconnectTimer.current);
      autoDisconnectTimer.current = null;
    }

    if (socket) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      setSocket(null);
    }

    setSocketState(SocketState.Unstarted);
    setRateLimited(false); // Reset rate limiting on manual disconnect
    setSessionExpired(false);
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (keepAlive.current) {
        clearInterval(keepAlive.current);
      }

      if (autoDisconnectTimer.current) {
        clearTimeout(autoDisconnectTimer.current);
      }

      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close();
      }
    };
  }, [socket]);

  return (
    <DeepgramContext.Provider
      value={{
        socket,
        socketState,
        rateLimited,
        sessionExpired,
        connectToDeepgram,
        disconnectFromDeepgram,
      }}
    >
      {children}
    </DeepgramContext.Provider>
  );
};

function useDeepgram() {
  return useContext(DeepgramContext);
}

export { DeepgramContextProvider, useDeepgram };
