# OOOSH Utilities

Central operations hub for OOOSH Tours — staff tools, monitoring, and automation.

## 🚀 Staff Hub

**URL:** `https://ooosh-utilities.netlify.app/?job=15298`

The Staff Hub provides single-login access to all internal tools:

| Tool | Description | Requires Job |
|------|-------------|--------------|
| 🚛 Crew & Transport | Quote deliveries, collections & crewed jobs | Yes |
| 🎸 Backline Matcher | Match equipment across jobs | No |
| 💳 Payment Portal | View customer payment page | Yes |
| 💰 Admin Refund | Process refunds and adjustments | Yes |
| 📦 Warehouse Sign-out | Track equipment check-out | No |
| 🚗 PCN Manager | Penalty charge notice processing | No |

### How It Works

1. Navigate to the hub (optionally with `?job=XXXXX` in URL)
2. Enter the shared staff PIN
3. Click any tool — you'll be authenticated automatically

### Adding New Tools

Edit `public/hub.js` and add to the `TOOLS` array:

```javascript
{
  id: 'my-tool',
  name: 'My New Tool',
  description: 'What it does',
  icon: '🔧',
  baseUrl: 'https://my-tool.netlify.app',
  requiresJob: true,    // or false
  jobParam: 'job'       // URL parameter name for job ID
}
```

Then add the token validation to your tool (see below).

### Token Validation (for receiving tools)

When a tool is launched from the hub, it receives a `hubToken` parameter.
Add this validation to accept hub logins:

```javascript
// In your tool's authentication
const urlParams = new URLSearchParams(window.location.search);
const hubToken = urlParams.get('hubToken');

if (hubToken) {
  // Validate with the hub
  const response = await fetch('https://ooosh-utilities.netlify.app/.netlify/functions/validate-tool-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: hubToken, toolId: 'my-tool' })
  });
  
  const data = await response.json();
  if (data.valid) {
    // User is authenticated! Set your local session
    // data.jobId contains the job number if provided
  }
}
```

---

## 🏥 Health Check

**Endpoint:** `/.netlify/functions/health-check`

Real-time monitoring of external services (every 30 minutes via Google Apps Script).

**Services Monitored:**
- Monday.com API
- Idenfy API
- Claude/Anthropic API
- HireHop API
- SMTP Configuration

---

## 📦 Dependency Check

**Endpoint:** `/.netlify/functions/dependency-check`

Weekly dependency and version monitoring (Monday 8am via Google Apps Script).

Add `?sendEmail=true` to trigger the email report.

**Checks Performed:**
- Node.js EOL status
- npm package versions across all repos
- Security vulnerabilities
- Monday.com API version sunset dates

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `STAFF_PIN` | Yes | Shared staff PIN for hub access |
| `STAFF_HUB_SECRET` | Yes | Secret for signing tokens |
| `GITHUB_TOKEN` | Yes | GitHub PAT with repo read access |
| `GITHUB_OWNER` | Yes | GitHub username (jon-ooosh) |
| `MONDAY_API_TOKEN` | Yes | Monday.com API token |
| `ANTHROPIC_API_KEY` | Yes | Claude API key |
| `IDENFY_API_KEY` | Yes | Idenfy API key |
| `IDENFY_API_SECRET` | Yes | Idenfy API secret |
| `HIREHOP_API_TOKEN` | Yes | HireHop API token |
| `HIREHOP_DOMAIN` | No | HireHop domain (default: myhirehop.com) |
| `SMTP_HOST` | Yes | SMTP server (smtp.gmail.com) |
| `SMTP_PORT` | No | SMTP port (default: 587) |
| `SMTP_USER` | Yes | SMTP username |
| `SMTP_PASS` | Yes | SMTP password/app password |

---

## Alerts

All alerts go to: `healthcheck@oooshtours.co.uk`

- **Health Check Failures:** Immediate email on service outage
- **Dependency Report:** Weekly summary every Monday

---

## Version History

- **v2.0** - Added Staff Hub with single sign-on for all tools
- **v1.0** - Initial implementation with health check and dependency monitoring
