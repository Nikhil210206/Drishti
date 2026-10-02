/** Options shared by every Sarvam client. In the extension, baseUrl will point at the proxy. */
export interface SarvamAuth {
  apiKey: string;
}

export function requireKey(auth: SarvamAuth) {
  if (!auth.apiKey) throw new Error("SARVAM_API_KEY is missing. Copy .env.example to .env and add your key.");
}
