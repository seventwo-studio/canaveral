// Supplied per HTML response by the dashboard gateway, never stored persistently.
export const cspNonce = () =>
  document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content;
