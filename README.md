# StageMyHome

WhatsApp-native virtual staging workflow for property agents.

## Run

```bash
npm run dev
```

Open `http://127.0.0.1:5173`.

## API Keys

For hackathon speed, use the in-app Settings panel:

- Paste the OpenAI API key. It is stored in server memory only.
- Paste Google OAuth Client ID and Client Secret.
- Use redirect URI: `http://localhost:5173/oauth/google/callback`.
- Click Save Settings, then Connect Google Drive.

For a longer local run, copy `.env.example` to `.env`. `.env` is gitignored.

## WhatsApp Integration

This repo vendors `lharries/whatsapp-mcp` under `vendor/whatsapp-mcp` for the live WhatsApp demo.

Run StageMyHome first:

```bash
npm run dev
```

Set these backend env vars for the demo:

```bash
OPENAI_API_KEY=sk-...
DEMO_WATCH_PHONE=6596629878
WHATSAPP_BRIDGE_URL=http://localhost:8080
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
SUPABASE_BUCKET=stagemyhome-images
```

Run the WhatsApp bridge in another terminal:

```bash
cd vendor/whatsapp-mcp/whatsapp-bridge
DEMO_WATCH_PHONE=6596629878 go run main.go
```

Scan the QR code from WhatsApp mobile: Settings -> Linked Devices -> Link a Device.

The bridge has been patched for the demo:

- Incoming text containing `stage`, `property`, `photo`, or `listing` gets an automated upload prompt.
- If `DEMO_WATCH_PHONE` is set, the bridge ignores other senders before forwarding anything to StageMyHome.
- Incoming image messages are downloaded locally.
- The downloaded image is forwarded to StageMyHome.
- StageMyHome creates a dashboard job and returns smart room questions.
- The bridge sends those questions back to the WhatsApp sender.

The StageMyHome bridge endpoint is:

```http
POST /api/whatsapp/inbound
Content-Type: application/json

{
  "agentNumber": "+6591234567",
  "projectName": "Tanjong Pagar 2BR",
  "recommendedPrompt": "Bright listing-ready staging...",
  "roomHints": ["Living Room", "Master Bedroom"],
  "photos": [
    {
      "fileName": "living.jpg",
      "mime": "image/jpeg",
      "base64": "..."
    }
  ]
}
```

Uploaded WhatsApp photos are sorted under:

```text
uploads/{phone}/{project}/
```

The endpoint returns room analysis plus the WhatsApp-ready response text.

## Demo Flow

1. Open WhatsApp Web and StageMyHome.
2. A sender messages your WhatsApp number about staging a listing.
3. The bridge replies asking them to upload room photos.
4. The sender uploads photos.
5. StageMyHome analyses room type and condition, creates a job, and asks smart room-specific questions.
6. Sender confirms preferences.
7. Operator clicks Agent Confirmed, then Verify Payment.
8. Operator clicks Generate.
9. Generated images appear in the dashboard.
10. Operator selects final images and clicks Compile + Send.
11. If Google Drive is connected, images upload to the operator Drive folder and the WhatsApp delivery link is prepared.

## Google Drive

Google Drive is connected once by the StageMyHome operator, not by property agents.

Create a Google OAuth web client and add this redirect URI exactly:

```text
http://localhost:5173/oauth/google/callback
```

In StageMyHome Settings, paste the Google Client ID and Secret, then click `Save + Connect Google Drive`.

## Supabase

Run `supabase/schema.sql` in the Supabase SQL editor.

Create a storage bucket named `stagemyhome-images`. For the hackathon, a public bucket is easiest. For production, keep it private and generate signed URLs.

Set Supabase env vars in your deployed backend:

```text
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_BUCKET=stagemyhome-images
```

## Demo Notes

- Use Room Labels for reliable presentation control.
- Use one generated variant per room for speed.
- Google Drive upload happens when Compile + Send is clicked and Drive is connected.
