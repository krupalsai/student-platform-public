# Self-hosted AI (open source, Docker, Oracle Always Free)

Runs an open-source model ([Ollama](https://ollama.com) + `qwen2.5:3b` by
default) for the **in-app Student Platform assistant**, on a free Oracle Cloud
VM. Caddy in front gives it real HTTPS and refuses every request without the
secret token.

**What it does for the app:** it is the **last-resort** AI. The assistant
tries Gemini → Groq → OpenRouter first; this server answers only when all
three are unavailable (free-tier limits, "high demand" outages), so students
still get an answer instead of "try again". Set `SELF_HOSTED_AI_ROLE=primary`
in Vercel to try it first instead.

**Be realistic about speed:** the free VM has no graphics card. On 4 ARM CPU
cores, `qwen2.5:3b` takes roughly **10–40 seconds** per answer (the prompt
carries the student's data and platform rules). That is fine for a backup,
slow for a main AI. It is **never used for WhatsApp**, whose webhook must
reply quickly.

Cost: ₹0 (Oracle Always Free + DuckDNS + Let's Encrypt). Oracle asks for a
card only to verify identity.

---

## 1. Create the VM (Oracle Cloud console)

1. Sign up at <https://cloud.oracle.com> (Always Free).
2. **Compute → Instances → Create instance**
   - Image: **Ubuntu 22.04** (or 24.04)
   - Shape: **Ampere → VM.Standard.A1.Flex**, **4 OCPUs, 24 GB memory**
     (the full Always Free allowance)
   - Add your SSH key, create.
   - "Out of capacity"? Try another availability domain, or retry later —
     common for free ARM shapes.
3. **Networking → the instance's subnet → Security List → Add Ingress Rules**:
   source `0.0.0.0/0`, TCP, destination ports **80** and **443**.
4. Note the instance's **public IP**.

## 2. Free hostname (needed for HTTPS)

At <https://www.duckdns.org> sign in, create a subdomain (e.g.
`studentai.duckdns.org`) and set it to the VM's public IP.

## 3. Install and start (on the VM)

```bash
ssh ubuntu@<public-ip>
git clone https://github.com/krupalsai/student-platform.git
cd student-platform/ai-server
bash setup.sh                    # installs Docker, opens 80/443, creates .env
nano .env                        # set AI_DOMAIN and AI_TOKEN (openssl rand -hex 32)
sudo docker compose up -d
sudo docker compose logs -f model-pull   # wait for "success" (a few minutes)
```

## 4. Check it

```bash
# Must be refused (no token):
curl -s -o /dev/null -w "%{http_code}\n" https://studentai.duckdns.org/api/tags      # 401
# Must work:
curl -s https://studentai.duckdns.org/api/tags -H "Authorization: Bearer <AI_TOKEN>"
```

## 5. Connect the app (Vercel → Project → Settings → Environment Variables)

| Variable | Value |
|---|---|
| `SELF_HOSTED_AI_URL` | `https://studentai.duckdns.org` |
| `SELF_HOSTED_AI_TOKEN` | the same `AI_TOKEN` |
| `SELF_HOSTED_AI_MODEL` | `qwen2.5:3b` (must match `AI_MODEL`) |
| `SELF_HOSTED_AI_ROLE` | *(optional)* `primary` to try it first |
| `SELF_HOSTED_AI_TIMEOUT_MS` | *(optional)* default `40000` |

Redeploy. Until both URL and token are set, the app ignores this server
entirely.

## Operating it

- **Update:** `git pull && sudo docker compose pull && sudo docker compose up -d`
- **Change model:** edit `AI_MODEL` in `.env` (and `SELF_HOSTED_AI_MODEL` in
  Vercel), then `sudo docker compose up -d model-pull`.
  `qwen2.5:7b` answers better, roughly 2–3× slower.
- **Restarts:** containers use `restart: unless-stopped`, so they come back
  after a VM reboot.
- **Logs:** `sudo docker compose logs -f ollama caddy`

## Security

- Ollama has no authentication of its own, so it is **never** published:
  only Caddy is reachable from the internet.
- Caddy allows exactly two paths (`/v1/chat/completions`, `/api/tags`) and
  only with `Authorization: Bearer <AI_TOKEN>`; everything else, including
  model downloads/deletes, gets 401.
- The model only ever receives what the app sends it for one question (the
  student's own snapshot, FAQs, recent turns). It has no database access and
  cannot act on anything.
- Rotate the token by changing `AI_TOKEN` and `SELF_HOSTED_AI_TOKEN` together.
