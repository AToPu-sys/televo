import { Ionicons } from "@expo/vector-icons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { Button } from "../src/components/Button";
import { useTheme } from "../src/hooks/useTheme";
import { supabase } from "../src/lib/supabase";
import { spacing } from "../src/theme";

/**
 * Scanned from an ALREADY signed-in device (Settings → Devices → Connect
 * Device) to authorize a new device shown in app/(auth)/qr-sign-in.tsx.
 * Two steps, both requiring an explicit tap — a scan alone never signs
 * anything in:
 *   1. mark_qr_login_scanned — as soon as the QR resolves, so the waiting
 *      device can show "Scanned — confirm on your other device" instead of
 *      sitting on a bare QR with no feedback.
 *   2. confirm_qr_login, on the "Sign in on new device?" tap here — THIS
 *      is what qr-login-exchange (Edge Function) checks before issuing a
 *      session, so a scan by itself (e.g. someone else's QR shown to your
 *      camera by mistake) never signs anyone in without this explicit
 *      confirm.
 */
export default function ScanQrLoginScreen() {
  const { theme } = useTheme();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [scannedRequestId, setScannedRequestId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const scanLockRef = useRef(false);

  async function handleBarcodeScanned({ data }: { data: string }) {
    if (scanLockRef.current) return;
    const match = data.match(/^televo:\/\/qr-login\/([0-9a-f-]+)$/i);
    if (!match) return;
    scanLockRef.current = true;

    const requestId = match[1];
    const { error } = await supabase.rpc("mark_qr_login_scanned", { p_request_id: requestId });
    if (error) {
      Alert.alert("Couldn't read this code", "It may have expired. Ask the other device for a new one.");
      scanLockRef.current = false;
      return;
    }
    setScannedRequestId(requestId);
  }

  async function handleConfirm() {
    if (!scannedRequestId) return;
    setConfirming(true);
    try {
      const { error: confirmError } = await supabase.rpc("confirm_qr_login", {
        p_request_id: scannedRequestId,
      });
      if (confirmError) {
        Alert.alert("Couldn't confirm", confirmError.message);
        return;
      }

      const { data: sessionData } = await supabase.auth.getSession();
      const { error: exchangeError } = await supabase.functions.invoke("qr-login-exchange", {
        body: { request_id: scannedRequestId },
        headers: sessionData.session
          ? { Authorization: `Bearer ${sessionData.session.access_token}` }
          : undefined,
      });
      if (exchangeError) {
        Alert.alert("Couldn't sign in the other device", exchangeError.message);
        return;
      }

      Alert.alert("Signed in", "Your other device is now signed in.", [
        { text: "OK", onPress: () => router.back() },
      ]);
    } finally {
      setConfirming(false);
    }
  }

  async function handleDeny() {
    if (!scannedRequestId) return;
    await supabase.rpc("deny_qr_login", { p_request_id: scannedRequestId });
    setScannedRequestId(null);
    scanLockRef.current = false;
  }

  if (!permission) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <ActivityIndicator color={theme.accent} style={styles.center} />
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={[styles.center, { padding: spacing.xl, gap: spacing.md }]}>
          <Ionicons name="camera-outline" size={48} color={theme.textSecondary} />
          <Text style={[styles.permissionText, { color: theme.text }]}>
            Televo needs camera access to scan a sign-in QR code.
          </Text>
          <Button title="Allow Camera Access" onPress={() => void requestPermission()} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.fill}>
      <CameraView
        style={styles.fill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={scannedRequestId ? undefined : handleBarcodeScanned}
      />
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.overlayHeader}>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            hitSlop={12}
            style={styles.overlayBackButton}
          >
            <Ionicons name="close" size={26} color="#FFFFFF" />
          </Pressable>
        </View>

        {!scannedRequestId ? (
          <View style={styles.overlayFooter}>
            <Text style={styles.overlayHint}>
              Point your camera at the QR code shown on your other device.
            </Text>
          </View>
        ) : (
          <View style={[styles.confirmSheet, { backgroundColor: theme.surfaceElevated }]}>
            <Text style={[styles.confirmTitle, { color: theme.text }]}>Sign in on new device?</Text>
            <Text style={[styles.confirmBody, { color: theme.textSecondary }]}>
              This will sign in your Televo account on the other device. If you didn't request this,
              deny it.
            </Text>
            <View style={styles.confirmActions}>
              <Button title="Deny" variant="secondary" onPress={() => void handleDeny()} />
              <Button title="Confirm" onPress={() => void handleConfirm()} loading={confirming} />
            </View>
          </View>
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  permissionText: { fontSize: 15, textAlign: "center" },
  overlay: { ...StyleSheet.absoluteFillObject, justifyContent: "space-between" },
  overlayHeader: { flexDirection: "row", justifyContent: "flex-end", padding: spacing.lg },
  overlayBackButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  overlayFooter: { padding: spacing.xl, paddingBottom: spacing.xxl },
  overlayHint: {
    color: "#FFFFFF",
    fontSize: 15,
    textAlign: "center",
    textShadowColor: "rgba(0,0,0,0.6)",
    textShadowRadius: 4,
  },
  confirmSheet: {
    margin: spacing.lg,
    marginBottom: spacing.xxl,
    padding: spacing.lg,
    borderRadius: 16,
    gap: spacing.sm,
  },
  confirmTitle: { fontSize: 17, fontWeight: "700" },
  confirmBody: { fontSize: 14, lineHeight: 20 },
  confirmActions: { flexDirection: "row", gap: spacing.md, marginTop: spacing.sm },
});
