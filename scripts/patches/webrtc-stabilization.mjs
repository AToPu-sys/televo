// Turns on iOS video stabilization for the call camera. react-native-webrtc
// starts an AVCaptureSession with stabilization off, so a hand-held phone
// shakes the picture — and a shaking picture also costs the encoder far more
// bits, so on a capped link it turns blocky exactly when the user moves.
// "Standard" stabilization (not cinematic: that adds about a second of
// latency) is applied to the video output's connection after every capture
// start, which includes each camera flip.
//
// node_modules is not committed, so this runs from postinstall and is
// idempotent (a marker comment guards a second application).
import fs from "node:fs";
import path from "node:path";

const file = path.join(path.dirname(new URL(import.meta.url).pathname), "../../node_modules/react-native-webrtc/ios/RCTWebRTC/VideoCaptureController.m");
if (!fs.existsSync(file)) process.exit(0);
let src = fs.readFileSync(file, "utf8");
const MARK = "/* televo: video stabilization */";
if (src.includes(MARK)) process.exit(0);

const anchor = `                                RCTLog(@"[VideoCaptureController] Capture started");
                                weakSelf.running = YES;`;
if (!src.includes(anchor)) {
  console.warn("[webrtc-stabilization] anchor not found — react-native-webrtc changed, patch not applied");
  process.exit(0);
}
src = src.replace(anchor, `${anchor}
                                ${MARK}
                                for (AVCaptureOutput *output in weakSelf.capturer.captureSession.outputs) {
                                    AVCaptureConnection *connection = [output connectionWithMediaType:AVMediaTypeVideo];
                                    if (connection.isVideoStabilizationSupported) {
                                        connection.preferredVideoStabilizationMode = AVCaptureVideoStabilizationModeStandard;
                                        RCTLog(@"[VideoCaptureController] stabilization: standard (active %ld)", (long)connection.activeVideoStabilizationMode);
                                    }
                                }`);
fs.writeFileSync(file, src);
console.log("[webrtc-stabilization] applied");
