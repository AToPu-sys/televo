/**
 * A minimal browser page that does real WebRTC — getUserMedia and
 * RTCPeerConnection — using the WebView's own browser engine (WKWebView on
 * iOS, Chromium WebView on Android). Both are included in Expo Go itself
 * (react-native-webview has inExpoGo: true), so this works without any
 * custom native module or dev build.
 *
 * React Native never touches WebRTC APIs directly. It sends commands in via
 * injectJavaScript() and receives events out via postMessage(), all JSON.
 * See src/hooks/useWebRtcBridge.ts for the RN-side half of this contract.
 */
export const WEBRTC_BRIDGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no" />
  <style>
    html, body { margin: 0; padding: 0; background: #000; width: 100%; height: 100%; overflow: hidden; }
    video { width: 100%; height: 100%; object-fit: cover; background: #000; }
    #remote { position: absolute; inset: 0; }
    #local { position: absolute; top: 0; right: 0; width: 96px; height: 128px; border-radius: 8px; overflow: hidden; }
  </style>
</head>
<body>
  <video id="remote" autoplay playsinline></video>
  <video id="local" autoplay playsinline muted></video>
  <script>
    (function () {
      var pc = null;
      var localStream = null;
      var pendingCandidates = [];

      function post(message) {
        window.ReactNativeWebView.postMessage(JSON.stringify(message));
      }

      function log(message) {
        post({ type: "log", message: String(message) });
      }

      window.onerror = function (message) {
        post({ type: "error", message: String(message) });
      };

      function ensurePeer(iceServers) {
        if (pc) return pc;
        pc = new RTCPeerConnection({ iceServers: iceServers });

        pc.onicecandidate = function (event) {
          if (event.candidate) {
            post({ type: "ice-candidate", candidate: event.candidate.toJSON() });
          }
        };

        pc.ontrack = function (event) {
          var remote = document.getElementById("remote");
          if (remote.srcObject !== event.streams[0]) {
            remote.srcObject = event.streams[0];
          }
        };

        pc.onconnectionstatechange = function () {
          post({ type: "connection-state", state: pc.connectionState });
        };

        return pc;
      }

      async function getMedia(video) {
        localStream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: video ? { facingMode: "user" } : false,
        });
        var local = document.getElementById("local");
        local.srcObject = localStream;
        local.style.display = video ? "block" : "none";
        return localStream;
      }

      async function handleCommand(command) {
        try {
          if (command.type === "start-local") {
            await getMedia(command.video);
            post({ type: "local-ready" });
          } else if (command.type === "create-offer") {
            var peer = ensurePeer(command.iceServers);
            var stream = localStream || (await getMedia(command.video));
            stream.getTracks().forEach(function (track) {
              peer.addTrack(track, stream);
            });
            var offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            post({ type: "offer", sdp: offer.sdp });
          } else if (command.type === "create-answer") {
            var peer = ensurePeer(command.iceServers);
            var stream = localStream || (await getMedia(command.video));
            stream.getTracks().forEach(function (track) {
              peer.addTrack(track, stream);
            });
            await peer.setRemoteDescription({ type: "offer", sdp: command.sdp });
            for (var i = 0; i < pendingCandidates.length; i++) {
              await peer.addIceCandidate(pendingCandidates[i]);
            }
            pendingCandidates = [];
            var answer = await peer.createAnswer();
            await peer.setLocalDescription(answer);
            post({ type: "answer", sdp: answer.sdp });
          } else if (command.type === "accept-answer") {
            if (!pc) return;
            await pc.setRemoteDescription({ type: "answer", sdp: command.sdp });
            for (var i = 0; i < pendingCandidates.length; i++) {
              await pc.addIceCandidate(pendingCandidates[i]);
            }
            pendingCandidates = [];
          } else if (command.type === "ice-candidate") {
            if (pc && pc.remoteDescription) {
              await pc.addIceCandidate(command.candidate);
            } else {
              pendingCandidates.push(command.candidate);
            }
          } else if (command.type === "set-mic") {
            if (localStream) {
              localStream.getAudioTracks().forEach(function (track) {
                track.enabled = command.enabled;
              });
            }
          } else if (command.type === "set-camera") {
            if (localStream) {
              localStream.getVideoTracks().forEach(function (track) {
                track.enabled = command.enabled;
              });
            }
            document.getElementById("local").style.display = command.enabled ? "block" : "none";
          } else if (command.type === "hangup") {
            if (localStream) {
              localStream.getTracks().forEach(function (track) {
                track.stop();
              });
              localStream = null;
            }
            if (pc) {
              pc.close();
              pc = null;
            }
            pendingCandidates = [];
          }
        } catch (error) {
          post({ type: "error", message: String(error && error.message ? error.message : error) });
        }
      }

      document.addEventListener("message", function (event) {
        handleCommand(JSON.parse(event.data));
      });
      window.addEventListener("message", function (event) {
        handleCommand(JSON.parse(event.data));
      });

      post({ type: "ready" });
    })();
  </script>
</body>
</html>`;
