import SwiftUI
import UIKit

/// Everything the voice-call screen shows; set from React Native props.
final class CallScreenModel: ObservableObject {
  @Published var peerName = ""
  @Published var avatarURL: URL?
  @Published var statusText = ""
  /// outgoing | incoming | connecting | active | ended
  @Published var phase = "outgoing"
  /// Media is actually flowing (not just "connected" on paper).
  @Published var connected = false
  @Published var reconnecting = false
  /// Signal quality from the call's stats: 0 poor … 3 excellent, -1 = unknown.
  @Published var quality = -1
  @Published var muted = false
  /// receiver | speaker | bluetooth | headphones | car | usb | airplay
  @Published var routeKind = "receiver"
  @Published var routeLabel = "Speaker"
  /// A headset is connected, so the audio button opens a picker.
  @Published var routeIsPicker = false
  @Published var canMinimize = false
}

/// The voice-call screen: a slowly moving colour field that follows the call's
/// state, the other person's avatar breathing with their voice, and large
/// labelled controls. Video calls keep their own screen (the video is drawn by
/// WebRTC there).
struct CallScreen: View {
  @ObservedObject var model: CallScreenModel
  let send: (String) -> Void
  @StateObject private var meter = LevelMeter()
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    ZStack {
      CallBackground(palette: palette, reduceMotion: reduceMotion)
        .ignoresSafeArea()
      VStack(spacing: 0) {
        topBar
        Spacer(minLength: 16)
        avatar
        Text(model.peerName)
          .font(.system(size: 30, weight: .semibold))
          .foregroundColor(.white)
          .lineLimit(1)
          .minimumScaleFactor(0.6)
          .padding(.top, 26)
        Text(model.statusText)
          .font(.system(size: 17).monospacedDigit())
          .foregroundColor(.white.opacity(0.75))
          .padding(.top, 6)
          .animation(.easeInOut(duration: 0.2), value: model.statusText)
        Spacer(minLength: 24)
        controls
          .padding(.bottom, 24)
      }
      .padding(.horizontal, 24)
    }
    .preferredColorScheme(.dark)
  }

  // MARK: - Pieces

  private var topBar: some View {
    HStack {
      if model.canMinimize {
        Button {
          haptic(.light)
          send("minimize")
        } label: {
          Image(systemName: "chevron.down")
            .font(.system(size: 18, weight: .semibold))
            .foregroundColor(.white)
            .frame(width: 44, height: 44)
            .background(Color.white.opacity(0.12), in: Circle())
        }
        .accessibilityLabel("Minimize call")
      } else {
        Color.clear.frame(width: 44, height: 44)
      }
      Spacer()
HStack(spacing: 8) {
        Label("Encrypted", systemImage: "lock.fill")
          .font(.system(size: 13, weight: .medium))
          .foregroundColor(.white.opacity(0.85))
        if model.quality >= 0 {
          SignalBars(level: model.quality)
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 6)
      .background(Color.white.opacity(0.12), in: Capsule())
      .animation(.easeInOut(duration: 0.25), value: model.quality)
      Spacer()
      Color.clear.frame(width: 44, height: 44)
    }
    .padding(.top, 8)
  }

  private var avatar: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 60, paused: reduceMotion)) { context in
      let time = context.date.timeIntervalSinceReferenceDate
      let voice = meter.next(model.phase == "active" ? TelevoAudioInstaller.speakerLevel() : 0)
      let ringing = model.phase == "outgoing" || model.phase == "incoming" || model.phase == "connecting"
      ZStack {
        if ringing {
          // Calling: rings travel outward from the avatar.
          ForEach(0..<3, id: \.self) { index in
            let progress = (time * 0.55 + Double(index) / 3).truncatingRemainder(dividingBy: 1)
            Circle()
              .stroke(Color.white.opacity(0.35 * (1 - progress)), lineWidth: 2)
              .frame(width: 140 + progress * 130, height: 140 + progress * 130)
          }
        }
        // Talking: two soft blobs that swell with the other person's voice.
        VoiceBlob(time: time, amplitude: 5 + voice * 30, lobes: 5)
          .fill(Color.white.opacity(0.10))
          .frame(width: 214, height: 214)
        VoiceBlob(time: time * 1.35 + 1.7, amplitude: 4 + voice * 20, lobes: 7)
          .fill(Color.white.opacity(0.16))
          .frame(width: 180, height: 180)
        AvatarView(url: model.avatarURL, name: model.peerName)
          .frame(width: 140, height: 140)
          .overlay(alignment: .bottomTrailing) {
            if model.muted && model.phase == "active" {
              Image(systemName: "mic.slash.fill")
                .font(.system(size: 13, weight: .bold))
                .foregroundColor(.white)
                .frame(width: 34, height: 34)
                .background(Color.red, in: Circle())
                .accessibilityLabel("Your microphone is off")
            }
          }
      }
      .frame(width: 280, height: 280)
    }
  }

  @ViewBuilder private var controls: some View {
    switch model.phase {
    case "incoming":
      HStack {
        CallActionButton(icon: "phone.down.fill", label: "Decline", style: .danger) {
          haptic(.medium)
          send("decline")
        }
        Spacer()
        CallActionButton(icon: "phone.fill", label: "Accept", style: .accept) {
          haptic(.medium)
          send("accept")
        }
      }
      .padding(.horizontal, 24)
    case "ended":
      Color.clear.frame(height: 100)
    default:
      HStack(alignment: .top, spacing: 30) {
        CallActionButton(
          icon: routeIcon,
          label: model.routeIsPicker ? model.routeLabel : "Speaker",
          style: model.routeKind == "receiver" ? .plain : .highlighted
        ) {
          haptic(.light)
          send("route")
        }
        CallActionButton(icon: model.muted ? "mic.slash.fill" : "mic.fill", label: model.muted ? "Unmute" : "Mute",
                         style: model.muted ? .highlighted : .plain) {
          haptic(.light)
          send("mute")
        }
        CallActionButton(icon: "phone.down.fill", label: "End", style: .danger) {
          haptic(.medium)
          send("hangup")
        }
      }
    }
  }

  private var routeIcon: String {
    switch model.routeKind {
    case "speaker": return "speaker.wave.2.fill"
    case "bluetooth": return "airpods"
    case "headphones", "usb": return "headphones"
    case "car": return "car.fill"
    case "airplay": return "airplayaudio"
    default: return model.routeIsPicker ? "iphone" : "speaker.wave.2.fill"
    }
  }

  /// Blue-violet while calling, green-teal once voices flow, amber while the
  /// link struggles, muted grey once it's over.
  private var palette: [Color] {
    if model.phase == "ended" {
      return [Color(rgb: 0x4A4A58), Color(rgb: 0x2C2C35), Color(rgb: 0x5E3A45)]
    }
    if model.reconnecting {
      return [Color(rgb: 0xD9902F), Color(rgb: 0xB8562E), Color(rgb: 0x6E4BC2)]
    }
    if model.phase == "active" && model.connected {
      return [Color(rgb: 0x2FB58A), Color(rgb: 0x2A86D6), Color(rgb: 0x5C55D9)]
    }
    return [Color(rgb: 0x4F72F5), Color(rgb: 0x8A55F2), Color(rgb: 0x2DB7DA)]
  }

  private func haptic(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
    UIImpactFeedbackGenerator(style: style).impactOccurred()
  }
}

// MARK: - Building blocks

/// Smooths the raw loudness so the blobs swell quickly and settle slowly,
/// like a voice, instead of flickering with every audio buffer.
final class LevelMeter: ObservableObject {
  private var value: Double = 0

  func next(_ raw: Float) -> Double {
    let target = Double(raw)
    value += (target - value) * (target > value ? 0.35 : 0.07)
    return value
  }
}

struct CallBackground: View {
  let palette: [Color]
  let reduceMotion: Bool

  var body: some View {
    TimelineView(.animation(minimumInterval: 1.0 / 30, paused: reduceMotion)) { context in
      let time = context.date.timeIntervalSinceReferenceDate
      GeometryReader { geo in
        ZStack {
          Color(rgb: 0x0C0D16)
          ForEach(0..<3, id: \.self) { index in
            let phase = Double(index) * 2.1
            Circle()
              .fill(palette[index])
              .frame(width: geo.size.width * 1.15, height: geo.size.width * 1.15)
              .blur(radius: 90)
              .opacity(0.75)
              .offset(x: cos(time * 0.21 + phase) * geo.size.width * 0.32,
                      y: sin(time * 0.17 + phase * 0.8) * geo.size.height * 0.28 - geo.size.height * 0.08)
          }
          LinearGradient(colors: [.black.opacity(0.05), .black.opacity(0.5)], startPoint: .top, endPoint: .bottom)
        }
        .animation(.easeInOut(duration: 1.2), value: palette.description)
      }
    }
  }
}

/// A circle whose edge ripples; `amplitude` is how far the ripples reach.
struct VoiceBlob: Shape {
  var time: Double
  var amplitude: Double
  var lobes: Int

  func path(in rect: CGRect) -> Path {
    let center = CGPoint(x: rect.midX, y: rect.midY)
    let base = min(rect.width, rect.height) / 2 - amplitude
    var path = Path()
    let steps = 120
    for step in 0...steps {
      let angle = Double(step) / Double(steps) * 2 * .pi
      let wobble = sin(Double(lobes) * angle + time * 1.9) * 0.55 + sin(3 * angle - time * 1.3) * 0.45
      let radius = base + amplitude * (0.5 + 0.5 * wobble)
      let point = CGPoint(x: center.x + CGFloat(cos(angle) * radius), y: center.y + CGFloat(sin(angle) * radius))
      if step == 0 { path.move(to: point) } else { path.addLine(to: point) }
    }
    path.closeSubpath()
    return path
  }
}

struct AvatarView: View {
  let url: URL?
  let name: String

  var body: some View {
    ZStack {
      initials
      if let url {
        AsyncImage(url: url) { image in
          image.resizable().scaledToFill()
        } placeholder: {
          Color.clear
        }
      }
    }
    .clipShape(Circle())
    .overlay(Circle().stroke(Color.white.opacity(0.25), lineWidth: 1))
    .accessibilityHidden(true)
  }

  private var initials: some View {
    let letters = name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    return ZStack {
      LinearGradient(colors: [Color(rgb: 0xE3A085), Color(rgb: 0xC0705A)], startPoint: .topLeading, endPoint: .bottomTrailing)
      Text(letters.isEmpty ? "?" : letters)
        .font(.system(size: 48, weight: .semibold, design: .serif))
        .foregroundColor(Color(rgb: 0x1A1414))
    }
  }
}

struct CallActionButton: View {
  enum Style { case plain, highlighted, danger, accept }

  let icon: String
  let label: String
  let style: Style
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      VStack(spacing: 9) {
        Image(systemName: icon)
          .font(.system(size: 25, weight: .semibold))
          .foregroundColor(iconColor)
          .frame(width: 72, height: 72)
          .background(background, in: Circle())
        Text(label)
          .font(.system(size: 13, weight: .medium))
          .foregroundColor(.white.opacity(0.85))
          .lineLimit(1)
          .frame(maxWidth: 92)
      }
    }
    .buttonStyle(PressScaleStyle())
    .accessibilityLabel(label)
  }

  private var background: Color {
    switch style {
    case .plain: return Color.white.opacity(0.16)
    case .highlighted: return Color.white.opacity(0.95)
    case .danger: return Color(rgb: 0xEB4D4B)
    case .accept: return Color(rgb: 0x34C759)
    }
  }

  private var iconColor: Color {
    style == .highlighted ? Color(rgb: 0x111218) : .white
  }
}

struct PressScaleStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.92 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

extension Color {
  init(rgb: UInt32) {
    self.init(red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255)
  }
}

/// Four signal bars, 0 (poor) … 3 (excellent): white when good, amber when
/// weak, red when poor — the same scale the video screen uses.
struct SignalBars: View {
  let level: Int

  var body: some View {
    let lit = min(max(level, 0), 3) + 1
    let tint: Color = level >= 2 ? .white : (level == 1 ? Color(rgb: 0xF2B33D) : Color(rgb: 0xEB4D4B))
    HStack(alignment: .bottom, spacing: 2) {
      ForEach(0..<4, id: \.self) { index in
        RoundedRectangle(cornerRadius: 1.5)
          .fill(index < lit ? tint : Color.white.opacity(0.28))
          .frame(width: 3, height: CGFloat(5 + index * 3))
      }
    }
    .frame(height: 14, alignment: .bottom)
    .accessibilityLabel(["Poor connection", "Weak connection", "Good connection", "Excellent connection"][min(max(level, 0), 3)])
  }
}
