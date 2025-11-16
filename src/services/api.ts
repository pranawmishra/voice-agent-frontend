// API service layer for communicating with the server
const API_BASE_URL = `${import.meta.env.VITE_BACKEND_URL}/api`;

class ApiService {
  private async request(endpoint: string, options: RequestInit = {}) {
    const url = `${API_BASE_URL}${endpoint}`;
    const headers = {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true', // Add this for ngrok
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'unknown error' }));
      throw new Error(error.error || 'Request failed');
    }

    return response.json();
  }

  // Basic function calls for voice assistant
  async handleFunctionCalls(functions: any[]) {
    return this.request('/voice/function-calls', {
      method: 'POST',
      body: JSON.stringify({ functions }),
    });
  }

  // Deepgram
  async getDeepgramConfig() {
    console.log('inside getDeepgramConfig');
    const agent_id = 'friday';
    return this.request('/deepgram/config', {
      method: 'POST',
      body: JSON.stringify({ agent_id }),
    });
  }

  async getDeepgramConnectionUrl() {
    return this.request('/deepgram/connection-url');
  }

  async getVoicePrompt() {
    return this.request('/deepgram/prompt');
  }
}

export const apiService = new ApiService();
export default apiService;
