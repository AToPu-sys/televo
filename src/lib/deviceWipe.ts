// On a phone, Secret Chat keys belong to the device and survive sign-out
// (the same person signs back in). Nothing extra to erase here.
export async function wipeDeviceSecretsOnSignOut(): Promise<void> {}
