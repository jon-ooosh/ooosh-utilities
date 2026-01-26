# OOOSH Utilities

Central monitoring and automation hub for OOOSH Tours systems.

## Functions

### 🏥 Health Check (`health-check.js`)

Real-time monitoring of external services.

**Frequency:** Every 30 minutes (via Google Apps Script)

**Services Monitored:**
- Monday.com API
- Idenfy API
- Claude/Anthropic API
- HireHop API
- SMTP Configuration

**Endpoint:** `/.netlify/functions/health-check`

---

### 📦 Dependency Check (`dependency-check.js`)

Weekly dependency and version monitoring.

**Frequency:** Weekly, Monday 8am UK time (via Google Apps Script)

**Checks Performed:**
- Node.js EOL status
- npm package versions across all repos
- Security vulnerabilities
- Monday.com API version sunset dates
- Standing advisories (CRA deprecation, etc.)

**Repositories Monitored:**
- Driver Verification
- Payment Portal
- Freelancer Portal
- PCN Management
- HireHop Stock

**Endpoint:** `/.netlify/functions/dependency-check`
- Add `?sendEmail=true` to send the email report

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
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

## Adding New Repos to Monitor

Edit `dependency-check.js` and add to the `REPOS_TO_MONITOR` array:

```javascript
{
  name: 'Display Name',
  repo: 'github-repo-name',
  description: 'What this project does'
}
```

---

## Alerts

All alerts go to: `healthcheck@oooshtours.co.uk`

- **Health Check Failures:** Immediate email on service outage
- **Dependency Report:** Weekly summary every Monday

---

## Version History

- **v1.0** - Initial implementation with health check and dependency monitoring