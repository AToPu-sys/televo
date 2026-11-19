import { expectAuthLink, mayApplyAuthLink, tokenSubject } from "../authLinkGuard";

const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  setItemAsync: async (k: string, v: string) => void mockStore.set(k, v),
  getItemAsync: async (k: string) => mockStore.get(k) ?? null,
  deleteItemAsync: async (k: string) => void mockStore.delete(k),
}));

function token(sub: string): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "HS256" })}.${part({ sub, aal: "aal1" })}.sig`;
}

beforeEach(() => mockStore.clear());

it("reads the account a token belongs to", () => {
  expect(tokenSubject(token("user-a"))).toBe("user-a");
  expect(tokenSubject("garbage")).toBeNull();
});

it("never swaps a signed-in user into another account", async () => {
  await expectAuthLink();
  expect(await mayApplyAuthLink(token("attacker"), "victim")).toBe(false);
  expect(await mayApplyAuthLink(token("victim"), "victim")).toBe(true);
});

it("signs in from a link only after this device asked for an email, once", async () => {
  expect(await mayApplyAuthLink(token("someone"), null)).toBe(false);
  await expectAuthLink();
  expect(await mayApplyAuthLink(token("someone"), null)).toBe(true);
  expect(await mayApplyAuthLink(token("someone"), null)).toBe(false);
});

it("ignores an expectation older than a day", async () => {
  mockStore.set("televo.authLinkExpectedAt", String(Date.now() - 25 * 60 * 60 * 1000));
  expect(await mayApplyAuthLink(token("someone"), null)).toBe(false);
});
