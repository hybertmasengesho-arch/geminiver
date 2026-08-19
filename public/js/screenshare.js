// screenshare.js — peer-to-peer screen sharing over WebRTC. Signaling (SDP
// offer/answer + ICE candidates) is exchanged by polling routes/screenshare.js
// every 1.5s instead of a websocket — the actual video stream, once
// connected, flows directly browser-to-browser via public STUN servers, not
// through this server.
(function () {
  function getToken() { return localStorage.getItem('rh_token'); }
  function authHeaders(json) {
    const h = { Authorization: 'Bearer ' + getToken() };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }
  async function api(path, opts) {
    const res = await fetch('/api/screenshare' + path, Object.assign({ headers: authHeaders(true) }, opts || {}));
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error(data.error || 'Screen share request failed');
    return data;
  }

  const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

  // ---- host side: shares this browser's screen, called from the widget ----
  async function startHosting(onStatus) {
    const { code } = await api('/start', { method: 'POST' });
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    stream.getTracks().forEach(t => pc.addTrack(t, stream));

    let appliedViewerCandidates = 0;
    let stopped = false;
    let pollTimer = null;

    pc.onicecandidate = (e) => {
      if (e.candidate) api('/' + code + '/candidate', { method: 'POST', body: JSON.stringify({ role: 'host', candidate: e.candidate }) }).catch(() => {});
    };
    pc.onconnectionstatechange = () => {
      if (onStatus) onStatus(pc.connectionState);
    };
    stream.getVideoTracks()[0].addEventListener('ended', () => stop());

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await api('/' + code + '/offer', { method: 'POST', body: JSON.stringify({ sdp: offer.sdp }) });

    async function poll() {
      if (stopped) return;
      try {
        const session = await api('/' + code, { method: 'GET' });
        if (session.answerSdp && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: session.answerSdp });
        }
        const candidates = session.candidates || [];
        for (; appliedViewerCandidates < candidates.length; appliedViewerCandidates++) {
          try { await pc.addIceCandidate(candidates[appliedViewerCandidates]); } catch (e) {}
        }
        if (session.status === 'ended') { stop(); return; }
      } catch (e) { /* transient — keep polling */ }
      pollTimer = setTimeout(poll, 1500);
    }
    poll();

    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(pollTimer);
      stream.getTracks().forEach(t => t.stop());
      pc.close();
      api('/' + code + '/end', { method: 'POST' }).catch(() => {});
      if (onStatus) onStatus('ended');
    }

    return { code, stop };
  }

  // ---- viewer side: an admin joining a host's shared screen ----
  async function joinSession(code, videoEl, onStatus) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    let appliedHostCandidates = 0;
    let stopped = false;
    let pollTimer = null;

    pc.ontrack = (e) => { videoEl.srcObject = e.streams[0]; };
    pc.onicecandidate = (e) => {
      if (e.candidate) api('/' + code + '/candidate', { method: 'POST', body: JSON.stringify({ role: 'viewer', candidate: e.candidate }) }).catch(() => {});
    };
    pc.onconnectionstatechange = () => { if (onStatus) onStatus(pc.connectionState); };

    const session = await api('/' + code + '/join', { method: 'POST' });
    if (!session.offerSdp) throw new Error('Host has not started sharing yet.');
    await pc.setRemoteDescription({ type: 'offer', sdp: session.offerSdp });
    appliedHostCandidates = 0;
    const initialCandidates = session.candidates || [];
    for (; appliedHostCandidates < initialCandidates.length; appliedHostCandidates++) {
      try { await pc.addIceCandidate(initialCandidates[appliedHostCandidates]); } catch (e) {}
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await api('/' + code + '/answer', { method: 'POST', body: JSON.stringify({ sdp: answer.sdp }) });

    async function poll() {
      if (stopped) return;
      try {
        const s = await api('/' + code, { method: 'GET' });
        const candidates = s.candidates || [];
        for (; appliedHostCandidates < candidates.length; appliedHostCandidates++) {
          try { await pc.addIceCandidate(candidates[appliedHostCandidates]); } catch (e) {}
        }
        if (s.status === 'ended') { stop(); return; }
      } catch (e) { /* transient — keep polling */ }
      pollTimer = setTimeout(poll, 1500);
    }
    poll();

    function stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(pollTimer);
      pc.close();
      videoEl.srcObject = null;
      api('/' + code + '/end', { method: 'POST' }).catch(() => {});
      if (onStatus) onStatus('ended');
    }

    return { stop };
  }

  async function listWaiting() {
    const data = await api('/waiting', { method: 'GET' });
    return data.sessions || [];
  }

  window.ScreenShare = { startHosting, joinSession, listWaiting, supported: !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) };
})();
