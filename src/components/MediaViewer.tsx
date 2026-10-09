import { Ionicons } from "@expo/vector-icons";
import { useVideoPlayer, VideoView } from "expo-video";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  FlatList,
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeSyntheticEvent,
  type NativeScrollEvent,
} from "react-native";

import { useE2ee } from "../hooks/useE2ee";
import { cachedMediaUri } from "../lib/mediaCache";

export type MediaViewerItem = { id: string; path: string; kind: "image" | "video" };

type Props = {
  items: MediaViewerItem[];
  initialIndex: number;
  conversationId: string;
  onClose: () => void;
};

const { height: SCREEN_HEIGHT } = Dimensions.get("window");
const DISMISS_DISTANCE = 120;

/** Full-screen photo/video viewer: swipe left/right between a chat's media,
 * swipe down (or tap the X) to dismiss. Pinch-to-zoom is intentionally left
 * out of this first pass — a plain Image/VideoView per page, matching how
 * most of this app's media already renders, rather than pulling in a new
 * gesture dependency for it. */
function MediaViewerInner({ items, initialIndex, conversationId, onClose }: Props) {
  const translateY = useRef(new Animated.Value(0)).current;
  const backdropOpacity = useRef(new Animated.Value(1)).current;
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const listRef = useRef<FlatList<MediaViewerItem>>(null);
  const isDraggingRef = useRef(false);

  const close = useCallback(() => {
    Animated.timing(backdropOpacity, { toValue: 0, duration: 150, useNativeDriver: true }).start(
      onClose
    );
  }, [backdropOpacity, onClose]);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gesture) =>
        Math.abs(gesture.dy) > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderGrant: () => {
        isDraggingRef.current = true;
      },
      onPanResponderMove: (_evt, gesture) => {
        if (gesture.dy > 0) {
          translateY.setValue(gesture.dy);
          backdropOpacity.setValue(1 - Math.min(gesture.dy / (SCREEN_HEIGHT * 0.6), 0.85));
        }
      },
      onPanResponderRelease: (_evt, gesture) => {
        isDraggingRef.current = false;
        if (gesture.dy > DISMISS_DISTANCE || gesture.vy > 1.2) {
          Animated.timing(translateY, {
            toValue: SCREEN_HEIGHT,
            duration: 200,
            useNativeDriver: true,
          }).start(onClose);
        } else {
          Animated.parallel([
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true, friction: 8 }),
            Animated.timing(backdropOpacity, { toValue: 1, duration: 150, useNativeDriver: true }),
          ]).start();
        }
      },
    })
  ).current;

  const handleMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const width = event.nativeEvent.layoutMeasurement.width || 1;
      const index = Math.round(event.nativeEvent.contentOffset.x / width);
      setCurrentIndex(index);
    },
    []
  );

  return (
    <Animated.View
      style={[styles.root, { opacity: backdropOpacity }]}
      {...panResponder.panHandlers}
    >
      <Animated.View style={{ flex: 1, transform: [{ translateY }] }}>
        <FlatList
          ref={listRef}
          data={items}
          horizontal
          pagingEnabled
          initialScrollIndex={initialIndex}
          getItemLayout={(_data, index) => {
            const { width } = Dimensions.get("window");
            return { length: width, offset: width * index, index };
          }}
          keyExtractor={(item) => item.id}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={handleMomentumEnd}
          scrollEnabled={!isDraggingRef.current}
          renderItem={({ item }) => (
            <MediaPage item={item} conversationId={conversationId} />
          )}
        />
      </Animated.View>

      <Pressable
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel="Close"
        hitSlop={12}
        style={styles.closeButton}
      >
        <Ionicons name="close" size={26} color="#FFFFFF" />
      </Pressable>

      {items.length > 1 ? (
        <View style={styles.counter}>
          <Text style={styles.counterText}>
            {currentIndex + 1} / {items.length}
          </Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

function MediaPage({
  item,
  conversationId,
}: {
  item: MediaViewerItem;
  conversationId: string;
}) {
  const { decryptBytesForConversation } = useE2ee();
  const [uri, setUri] = useState<string | null>(
    item.path.startsWith("file:") || item.path.startsWith("content:") ? item.path : null
  );
  const { width } = Dimensions.get("window");

  useEffect(() => {
    if (uri) return;
    let active = true;
    cachedMediaUri(item.path, (ciphertext, nonce) =>
      decryptBytesForConversation(conversationId, ciphertext, nonce)
    ).then((resolved) => {
      if (active && resolved) setUri(resolved);
    });
    return () => {
      active = false;
    };
  }, [item.path, conversationId, decryptBytesForConversation, uri]);

  const player = useVideoPlayer(item.kind === "video" ? uri ?? null : null, (p) => {
    p.loop = false;
  });

  if (!uri) {
    return <View style={[styles.page, { width }]} />;
  }

  if (item.kind === "video") {
    return (
      <View style={[styles.page, { width }]}>
        <VideoView
          player={player}
          style={styles.fullMedia}
          contentFit="contain"
          nativeControls
        />
      </View>
    );
  }

  return (
    <View style={[styles.page, { width }]}>
      <Image source={{ uri }} style={styles.fullMedia} resizeMode="contain" />
    </View>
  );
}

export const MediaViewer = memo(MediaViewerInner);

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#000000",
    zIndex: 1000,
  },
  page: { height: "100%", alignItems: "center", justifyContent: "center" },
  fullMedia: { width: "100%", height: "100%" },
  closeButton: {
    position: "absolute",
    top: 56,
    right: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  counter: {
    position: "absolute",
    top: 60,
    alignSelf: "center",
    backgroundColor: "rgba(0,0,0,0.4)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
  },
  counterText: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
});
