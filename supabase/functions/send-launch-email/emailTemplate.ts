// Shared HTML shell for every email this function (and send-launch-email)
// sends, matching gettelevo.space's visual language — warm charcoal, coral
// accent, serif headline — instead of a bare, unstyled paragraph. Built as
// an HTML table (not flexbox/grid) because that's still what reliably
// renders the same way across Gmail, Outlook and Apple Mail; CSS here is
// all inline for the same reason, since many clients strip <style> blocks.
export function renderEmail(opts: {
  preheader: string;
  heading: string;
  bodyHtml: string;
  ctaLabel?: string;
  ctaUrl?: string;
  // Short marketing highlights shown as a 3-row feature strip between the
  // body copy and the CTA — the "why Televo" reminder every email carries,
  // not just a bare transactional notice. Each entry is {icon, title, body}.
  features?: { icon: string; title: string; body: string }[];
}): string {
  const { preheader, heading, bodyHtml, ctaLabel, ctaUrl, features } = opts;

  const ctaRow =
    ctaLabel && ctaUrl
      ? `<tr>
          <td style="padding: 24px 36px 8px;">
            <a href="${ctaUrl}" style="display:inline-block; background:#E3A085; color:#1A1414; font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:700; text-decoration:none; padding:14px 30px; border-radius:99px;">${ctaLabel}</a>
          </td>
        </tr>`
      : "";

  const featureRows = (features ?? [])
    .map(
      (f) => `
            <tr>
              <td style="padding: 14px 0; border-top:1px solid #332F3A;">
                <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                  <tr>
                    <td style="width:36px; vertical-align:top; font-size:18px; line-height:1;">${f.icon}</td>
                    <td style="vertical-align:top; font-family:Arial,Helvetica,sans-serif;">
                      <div style="font-size:14px; font-weight:700; color:#F4EFE9; margin-bottom:3px;">${f.title}</div>
                      <div style="font-size:13px; color:#A39C94; line-height:1.5;">${f.body}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>`
    )
    .join("");

  const featureBlock = features?.length
    ? `<tr>
        <td style="padding: 8px 36px 4px;">
          <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
            ${featureRows}
          </table>
        </td>
      </tr>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
</head>
<body style="margin:0; padding:0; background:#0E0D11; font-family:Georgia,'Times New Roman',serif;">
  <!-- Preheader: shown in inbox preview, hidden in the body -->
  <div style="display:none; max-height:0; overflow:hidden; opacity:0;">${preheader}</div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0E0D11;">
    <tr>
      <td align="center" style="padding: 40px 20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px; background:#17161B; border:1px solid #332F3A; border-radius:20px; overflow:hidden;">

          <!-- Hero band: warm coral gradient, brand mark, one-line tagline -->
          <tr>
            <td style="background:#E3A085; background:linear-gradient(135deg,#E3A085,#C77F63); padding: 28px 36px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="width:30px; height:30px; background:#1A1414; border-radius:9px; text-align:center; vertical-align:middle;">
                    <span style="font-family:Georgia,serif; font-weight:700; font-size:15px; color:#E3A085; line-height:30px;">T</span>
                  </td>
                  <td style="padding-left:10px; font-family:Georgia,serif; font-weight:600; font-size:19px; color:#1A1414;">Televo</td>
                </tr>
              </table>
              <div style="margin-top:10px; font-family:Arial,Helvetica,sans-serif; font-size:12.5px; font-weight:700; letter-spacing:.03em; color:#1A1414; opacity:0.75;">A QUIET PLACE TO SAY WHAT YOU MEAN</div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 28px 36px 8px;">
              <h1 style="margin:0 0 16px; font-family:Georgia,'Times New Roman',serif; font-weight:500; font-size:26px; line-height:1.25; color:#F4EFE9;">${heading}</h1>
              <div style="font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:1.65; color:#A39C94;">
                ${bodyHtml}
              </div>
            </td>
          </tr>

          ${ctaRow}

          ${featureBlock}

          <!-- Footer -->
          <tr>
            <td style="padding: 32px 36px 32px;">
              <div style="border-top:1px solid #332F3A; padding-top:20px; font-family:Arial,Helvetica,sans-serif; font-size:12.5px; color:#716B64; line-height:1.6;">
                Televo — a private messenger built with Expo and Supabase. No ads, no tracking, no data broker.<br>
                <a href="https://gettelevo.space" style="color:#E3A085; text-decoration:none;">gettelevo.space</a>
              </div>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
