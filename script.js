if (!navigator.mediaDevices || !window.MediaStream) {
  updateStatus("WebRTC not supported in this browser");
}

const API_CONFIG = {
  apiKey: "MDQ1ZDgwYzgzNDc1NDRhZjgyYjVlOWI0OWRmYWQ0NGMtMTc0MzEyODU1NA==",
  serverUrl: "https://api.heygen.com",
};
const ASSEMBLY_API_KEY = "61bdee1fb59a40359276dfa83b8cb1aa";

let sessionToken, sessionInfo, room, webSocket, mediaStream;
let audioContext, analyser, mediaRecorder, isVoiceOn = false, recording = false, audioChunks = [], silenceCounter = 0;

const talkBtn = document.getElementById("talkBtn");
const voiceBtn = document.getElementById("voiceBtn");
const taskInput = document.getElementById("taskInput");
const mediaElement = document.getElementById("mediaElement");
const connectingOverlay = document.getElementById("connectingOverlay");

const updateStatus = msg => {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
};

const enableControls = (state) => {
  taskInput.disabled = !state;
  talkBtn.disabled = !state;
  voiceBtn.disabled = !state;
};

const showConnecting = (show) => {
  connectingOverlay.style.display = show ? 'flex' : 'none';
};

const getSessionToken = async () => {
  const res = await fetch(`${API_CONFIG.serverUrl}/v1/streaming.create_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": API_CONFIG.apiKey },
  });
  sessionToken = (await res.json()).data.token;
  updateStatus("Session token obtained");
};

const connectWebSocket = async (sessionId) => {
  const wsUrl = `wss://${new URL(API_CONFIG.serverUrl).hostname}/v1/ws/streaming.chat?session_id=${sessionId}&session_token=${sessionToken}&opening_text=Hello, I'm the virtual CEO of Vostok VR, an award-winning emerging tech agency in Singapore. Feel free to ask about our current and past projects and experiences.`;
  webSocket = new WebSocket(wsUrl);
  webSocket.onmessage = (e) => console.log("WS:", JSON.parse(e.data));
};

const createSession = async () => {
  if (!sessionToken) await getSessionToken();
  const res = await fetch(`${API_CONFIG.serverUrl}/v1/streaming.new`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ quality: "high", avatar_name: "b082df383db140ed9a1b0b5c2b193e26", knowledge_base_id: "73d3457499824891b2d75d61ff0f4c54", stt_language: "eng", voice: { rate: 1.0 }, version: "v2", video_encoding: "H264" })
  });
  sessionInfo = (await res.json()).data;
  
  showConnecting(true);
  updateStatus("Creating session...");
};

const interruptCurrentSpeech = async () => {
  if (!sessionInfo) return;
  
  try {
    await fetch(`${API_CONFIG.serverUrl}/v1/streaming.interrupt`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json", 
        Authorization: `Bearer ${sessionToken}` 
      },
      body: JSON.stringify({ 
        session_id: sessionInfo.session_id
      })
    });
    updateStatus('Speech interrupted');
  } catch (error) {
    console.error("Error interrupting speech:", error);
  }
};

const sendText = async (text) => {
  if (!sessionInfo) return;
  
  // Прерываем текущую речь перед отправкой нового текста
  await interruptCurrentSpeech();
  
  // Отправляем новую задачу
  const response = await fetch(`${API_CONFIG.serverUrl}/v1/streaming.task`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ session_id: sessionInfo.session_id, text, task_type: "talk" }),
  });
  
  updateStatus(`Sent: ${text}`);
};

const handleTrackSubscribed = (track) => {
  mediaStream.addTrack(track.mediaStreamTrack);
  
  if (mediaStream.getVideoTracks().length && mediaStream.getAudioTracks().length) {
    mediaElement.srcObject = mediaStream;
    
    const handlePlay = async () => {
      try {
        await mediaElement.play();
        const playButton = document.getElementById('manualPlayBtn');
        if (playButton) playButton.remove();
      } catch (e) {
        updateStatus(`Playback error: ${e}`);
        addManualPlayButton();
      }
    };

    const addManualPlayButton = () => {
      if (!document.getElementById('manualPlayBtn')) {
        const btn = document.createElement('button');
        btn.id = 'manualPlayBtn';
        btn.className = 'absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 ' +
                         'px-4 py-2 bg-red-500 text-white rounded-lg shadow-lg hover:bg-red-600';
        btn.textContent = 'Click to Play';
        btn.onclick = handlePlay;
        
        mediaElement.parentElement.appendChild(btn);
      }
    };

    handlePlay().catch(e => {
      updateStatus(`Initial playback failed: ${e}`);
      addManualPlayButton();
    });
  }
};

const startStreaming = async () => {
  await fetch(`${API_CONFIG.serverUrl}/v1/streaming.start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ session_id: sessionInfo.session_id }),
  });
  
  mediaStream = new MediaStream();
  room = new LivekitClient.Room();
  room.on(LivekitClient.RoomEvent.TrackSubscribed, handleTrackSubscribed);
  
  await room.prepareConnection(sessionInfo.url, sessionInfo.access_token);
  await connectWebSocket(sessionInfo.session_id);
  await room.connect(sessionInfo.url, sessionInfo.access_token);
  
  enableControls(true);
  showConnecting(false);
  updateStatus("Streaming started");
  startVoiceAutomatically();
};

const processAudio = async () => {
  const blob = new Blob(audioChunks, { type: 'audio/webm' });
  const upload = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST", headers: { authorization: ASSEMBLY_API_KEY }, body: blob
  });
  const { upload_url } = await upload.json();
  const transcript = await fetch("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { authorization: ASSEMBLY_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ audio_url: upload_url })
  });
  const { id } = await transcript.json();
  const poll = async () => {
    const res = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { authorization: ASSEMBLY_API_KEY }
    });
    const { status, text } = await res.json();
    if (status === "completed" && text) {
      taskInput.value = text;
      sendText(text);
    } else if (status !== "completed") {
      setTimeout(poll, 1000);
    }
  };
  poll();
};

const checkVolume = () => {
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const vol = data.reduce((a, b) => a + b, 0) / data.length;
  return vol;
};

// Event Listeners and Initialization
document.addEventListener('DOMContentLoaded', () => {
  talkBtn.onclick = () => {
    if (taskInput.value.trim()) {
      sendText(taskInput.value);
      taskInput.value = '';
    }
  };

  voiceBtn.onclick = async () => {
    if (!isVoiceOn) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        audioContext = new AudioContext();
        analyser = audioContext.createAnalyser();
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
        mediaRecorder.onstop = processAudio;
        
        recording = true;
        mediaRecorder.start();
        voiceBtn.style.backgroundColor = '#ef4444';
        
        const checkSilence = () => {
          if (!recording) return;
          const volume = checkVolume();
          if (volume < 20) {
            silenceCounter++;
            if (silenceCounter > 50) {
              mediaRecorder.stop();
              recording = false;
              voiceBtn.style.backgroundColor = '#3b82f6';
              silenceCounter = 0;
              return;
            }
          } else {
            silenceCounter = 0;
          }
          requestAnimationFrame(checkSilence);
        };
        checkSilence();
        
      } catch (err) {
        updateStatus(`Microphone error: ${err}`);
      }
    } else {
      if (recording) {
        mediaRecorder.stop();
        recording = false;
        voiceBtn.style.backgroundColor = '#3b82f6';
      }
    }
    isVoiceOn = !isVoiceOn;
  };

  createSession().then(startStreaming);
}); 