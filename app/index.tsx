import { Redirect } from "expo-router";

// The root navigator decides where to go once the session is known; this just
// keeps "/" from being a dead route.
export default function Index() {
  return <Redirect href="/(tabs)/chats" />;
}
