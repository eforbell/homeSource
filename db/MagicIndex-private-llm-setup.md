# HomeSource MagicIndex — Local LLM Setup Guide

Private, local language model configuration for document metadata extraction.
All processing stays on your LAN. No data leaves your network.

---

## Overview

MagicIndex uses a local LLM to read document text and extract structured metadata (title, dates, parties, tags, etc.). The LLM runs on your home network via [Ollama](https://ollama.com), and HomeSource connects using Ollama's native API (`MAGICINDEX_PROVIDER=ollama`).

### What You Need

- A machine with a supported GPU to run the model
- Ollama installed on that machine
- Network access from your HomeSource server to the Ollama host

### Supported Hardware

| Hardware | Performance | Notes |
|----------|-------------|-------|
| Apple Silicon Mac (M1/M2/M3/M4) | Excellent | Metal GPU acceleration, unified memory. **Recommended.** |
| NVIDIA GPU (RTX 3060+, 12GB+ VRAM) | Excellent | CUDA acceleration. Works on Linux and Windows. |
| CPU-only (any OS, 16GB+ RAM) | Slow but functional | ~5-15 tok/s on a 4B model. Usable for light workloads. |
| AMD GPU (RX series) | Not recommended | No ROCm/Metal support in Ollama. Falls back to CPU. |

### Model Options

| Model | Size in RAM | Best For |
|-------|-------------|----------|
| **Qwen3 4B** (`qwen3:4b`) | ~3.5 GB | Default. Fast, accurate for metadata extraction. Fits on 8GB+ devices. |
| **Qwen3 30B-A3B** (`qwen3:30b-a3b`) | ~6-8 GB | Complex documents, dense legal/financial text. Requires 12GB+ VRAM. |

The 4B model is sufficient for most household documents (insurance, invoices, tax forms, contracts, medical records). Use the 30B MoE model only if extraction quality on the 4B is inadequate for your documents.

---

## Step 1: Install Ollama

### macOS (Homebrew — recommended for Apple Silicon)

```bash
brew install ollama
brew services start ollama
```

### macOS (Direct Download)

Download from https://ollama.com and drag to Applications. Launches as a menu bar app.

### Linux

```bash
curl -fsSL https://ollama.com/install.sh | sh
```

### Windows

Download the installer from https://ollama.com. Installs as a system tray service.

Verify installation:

```bash
ollama --version
```

---

## Step 2: Pull the Base Model

```bash
# For the 4B model (recommended)
ollama pull qwen3:4b

# For the 30B MoE model (advanced, requires 12GB+ VRAM)
ollama pull qwen3:30b-a3b
```

---

## Step 3: Create the No-Think Model Variant

Qwen3 models default to "thinking mode" which burns thousands of tokens on internal reasoning before answering. For structured metadata extraction this is wasteful and slow. We create a modified model variant that skips thinking.

### 3a. Export the base Modelfile

```bash
# For the 4B model
ollama show qwen3:4b --modelfile > /tmp/qwen3-nothink.modelfile

# For the 30B model
ollama show qwen3:30b-a3b --modelfile > /tmp/qwen3-nothink.modelfile
```

### 3b. Edit the Modelfile

Open `/tmp/qwen3-nothink.modelfile` in a text editor. You need to make three changes:

**Change 1 — Fix the FROM line.** Replace the blob path with the model name:

```
# BEFORE (blob path varies by machine)
FROM /path/to/blobs/sha256-abc123...

# AFTER
FROM qwen3:4b
```

(Use `FROM qwen3:30b-a3b` if setting up the 30B model.)

**Change 2 — Fix the assistant preamble.** Find the last occurrence of `<think>` near the bottom of the TEMPLATE block. It will look like this:

```
{{- if and (ne .Role "assistant") $last }}<|im_start|>assistant
<think>
{{ end }}
```

Replace it with:

```
{{- if and (ne .Role "assistant") $last }}<|im_start|>assistant
<think>
</think>
{
{{ end }}
```

This closes the think block immediately and prefills with `{` to nudge the model into outputting JSON directly.

**Change 3 — Remove thinking display logic.** Find this block in the assistant message section:

```
{{ if (and $.IsThinkSet (and .Thinking (or $last (gt $i $lastUserIdx)))) -}}
<think>{{ .Thinking }}</think>
{{ end -}}
```

Delete those three lines entirely.

**Change 4 — Fix corrupted Function.Name (if present).** If you see:

```
{{ .[Function.Name](http://Function.Name) }}
```

Replace with:

```
{{ .Function.Name }}
```

This is a copy-paste corruption artifact. The correct Go template syntax has no brackets or URL.

### 3c. Create the model variant

```bash
# For the 4B model
ollama create qwen3-4b-nothink -f /tmp/qwen3-nothink.modelfile

# For the 30B model
ollama create qwen3-nothink -f /tmp/qwen3-nothink.modelfile
```

### 3d. Verify

```bash
ollama run qwen3-4b-nothink "Reply with exactly: OK"
```

Expected output: `OK` (with no thinking preamble). If you see `<think>` tags or reasoning text, the Modelfile edit was not applied correctly. Re-check Step 3b.

---

## Step 4: Expose Ollama on Your LAN

By default Ollama only listens on `localhost`. To allow HomeSource (running on another machine) to connect, bind Ollama to all interfaces.

### macOS (Homebrew)

Edit the Homebrew service plist:

```bash
nano /opt/homebrew/opt/ollama/homebrew.mxcl.ollama.plist
```

Add (or update) the `EnvironmentVariables` dict:

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>OLLAMA_HOST</key>
    <string>0.0.0.0</string>
    <key>OLLAMA_KEEP_ALIVE</key>
    <string>-1</string>
</dict>
```

- `OLLAMA_HOST=0.0.0.0` — listen on all network interfaces
- `OLLAMA_KEEP_ALIVE=-1` — keep the model loaded in memory permanently (no cold start)

Restart the service:

```bash
brew services restart ollama
```

Allow through macOS firewall:

```bash
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /opt/homebrew/bin/ollama
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblock /opt/homebrew/bin/ollama
```

### macOS (Direct Download App)

```bash
launchctl setenv OLLAMA_HOST 0.0.0.0
launchctl setenv OLLAMA_KEEP_ALIVE -1
```

Quit and reopen Ollama from the menu bar. Note: `launchctl setenv` does not survive reboots. For persistence, create a LaunchAgent plist or switch to the Homebrew installation method.

### Linux

```bash
sudo systemctl edit ollama
```

Add:

```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0"
Environment="OLLAMA_KEEP_ALIVE=-1"
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl restart ollama
```

Firewall (UFW):

```bash
sudo ufw allow from 192.168.0.0/24 to any port 11434
sudo ufw deny 11434
```

Adjust the subnet (`192.168.0.0/24`) to match your LAN.

### Windows

Set system environment variables:

1. Open **System Settings → Advanced System Settings → Environment Variables**
2. Under **System variables**, click **New**
3. Add `OLLAMA_HOST` = `0.0.0.0`
4. Add `OLLAMA_KEEP_ALIVE` = `-1`
5. Restart the Ollama service (right-click tray icon → Quit, then relaunch)

Windows Firewall:

```powershell
New-NetFirewallRule -DisplayName "Ollama LAN" -Direction Inbound -Protocol TCP -LocalPort 11434 -RemoteAddress 192.168.0.0/24 -Action Allow
```

Adjust `192.168.0.0/24` to your actual LAN subnet.

### Verify LAN Access

From your HomeSource host:

```bash
curl http://<ollama-host-ip>:11434/v1/models
```

Expected response: JSON listing your installed models.

---

## Step 5: Configure HomeSource

Add these to your HomeSource `.env` file:

```bash
# --- MagicIndex LLM Configuration ---

# Provider selection
MAGICINDEX_PROVIDER=ollama
MAGICINDEX_PROVIDER_PRIVATE=yes
MAGICINDEX_PROVIDER_DEFAULT=ollama

# Ollama connection (replace with your Ollama host's LAN IP)
MAGICINDEX_OLLAMA_BASE_URL=http://<ollama-host-ip>:11434
MAGICINDEX_OLLAMA_MODEL=qwen3-4b-nothink
```

Replace `<ollama-host-ip>` with the actual LAN IP of the machine running Ollama (e.g., `192.168.1.243`).

If using the 30B MoE model instead:

```bash
MAGICINDEX_OLLAMA_MODEL=qwen3-nothink
```

Restart HomeSource after updating `.env`.

---

## Step 6: Test the Pipeline

Run a test extraction from the HomeSource host:

```bash
curl -s "http://<ollama-host-ip>:11434/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-4b-nothink",
    "messages": [
      {
        "role": "system",
        "content": "Extract document metadata as JSON. Required keys: title, document_type, summary, issued_date, expiry_date, amount, suggested_tags, suggested_owners, key_facts, confidence, field_confidence, needs_review_reasons. Return ONLY valid JSON."
      },
      {
        "role": "user",
        "content": "Text preview: Invoice #1042 from Acme Corp to Jane Doe dated 2024-03-15 for $2,450.00. Payment due in 30 days. Return JSON only."
      }
    ],
    "temperature": 0
  }' | jq '.choices[0].message.content'
```

You should receive a JSON object with extracted metadata. Some models may still leak thinking artifacts — HomeSource handles cleanup automatically.

---

## Response Cleanup (Developer Reference)

The no-think Modelfile suppresses most thinking output, but some models may still leak `<think>` blocks, markdown fences, or duplicate JSON payloads.

HomeSource's Ollama parser is defensive:

1. Strips leaked `<think>...</think>` fragments and fenced markdown wrappers
2. Attempts direct `JSON.parse` on cleaned output
3. If needed, extracts complete `{...}` object candidates and parses from the end (prefers last valid object)

This makes parsing resilient when local models return extra reasoning text before/after the JSON payload.

```js
function parseLLMResponse(content) {
  // Strip any think blocks that leaked through
  content = content.replace(/<think>[\s\S]*?<\/think>/g, '');

  // Find the last complete JSON object
  const lastBrace = content.lastIndexOf('}');
  const firstBrace = content.lastIndexOf('{', lastBrace);
  if (firstBrace !== -1 && lastBrace !== -1) {
    content = content.substring(firstBrace, lastBrace + 1);
  }

  return JSON.parse(content);
}
```

This extracts the last complete `{...}` block from the response, which is the clean JSON output.

---

## Monitoring

Check model status:

```bash
# See what's loaded
curl -s http://<ollama-host-ip>:11434/api/ps | jq .

# Or from the Ollama host directly
ollama ps
```

Expected output shows the model loaded with GPU acceleration:

```
NAME                       ID              SIZE      PROCESSOR    UNTIL
qwen3-4b-nothink:latest    878afa99d74f    3.5 GB    100% GPU     Forever
```

---

## Troubleshooting

### Model not loading / slow to load

- **Apple Silicon:** Should load in 2-5 seconds. If slow, check `ollama ps` for processor type — should say `100% GPU`.
- **NVIDIA:** Ensure CUDA drivers are installed. `nvidia-smi` should show the GPU.
- **CPU fallback:** If processor shows `100% CPU`, the GPU is not being used. Check driver installation.

### Empty responses

- The no-think Modelfile may need reapplication. Run `ollama show <model> --modelfile` and verify the template changes from Step 3b are present.
- Check that the `{` prefill is in the assistant preamble.

### Connection refused from HomeSource host

1. Verify Ollama is listening: `lsof -i :11434` (Mac/Linux) or `netstat -an | findstr 11434` (Windows)
2. Should show `*:11434` not `127.0.0.1:11434`
3. Check firewall rules on the Ollama host
4. Test with `curl http://<ip>:11434` from the HomeSource host

### Thinking text in responses

- Verify the Modelfile template was correctly modified (Step 3b)
- Rebuild the model: `ollama create qwen3-4b-nothink -f /tmp/qwen3-nothink.modelfile`
- HomeSource's response parser strips residual thinking — this is expected behavior

### VRAM sharing (gaming rig)

If the Ollama host is also used for gaming, set `OLLAMA_KEEP_ALIVE=5m` instead of `-1` so the model unloads after 5 minutes idle, freeing VRAM. Or stop Ollama from the system tray before gaming.

- `OLLAMA_KEEP_ALIVE=-1` → best latency, model always warm
- `OLLAMA_KEEP_ALIVE=5m` → better shared-GPU behavior, lower idle VRAM use

---

## Custom Model Storage Location

By default Ollama stores models in `~/.ollama/models`. To change (e.g., external drive):

### macOS (Homebrew)

Add to the plist `EnvironmentVariables`:

```xml
<key>OLLAMA_MODELS</key>
<string>/path/to/your/models</string>
```

### Linux

Add to the systemd override:

```ini
Environment="OLLAMA_MODELS=/path/to/your/models"
```

### Windows

Add system environment variable `OLLAMA_MODELS` pointing to the desired directory.

Restart Ollama after changing. Existing models are not moved automatically — re-pull or manually relocate.

---

## Security Notes

- Ollama has **no authentication** by default. Firewall to your LAN subnet only.
- `MAGICINDEX_PROVIDER_PRIVATE=yes` tells HomeSource this is a private model — document content is never logged or transmitted externally.
- After initial model pull, you can block Ollama's outbound internet access for full air-gap operation.
- Temp files from PDF rasterization/OCR are cleaned up automatically after processing.
