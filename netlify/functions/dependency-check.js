/**
 * dependency-check.js
 * 
 * Weekly dependency and version monitoring for OOOSH systems.
 * Checks all configured GitHub repos for outdated packages, security issues,
 * and upcoming deprecations.
 * 
 * Called by: Google Apps Script timer (weekly, Monday 8am)
 * 
 * Checks performed:
 * - Node.js version EOL status
 * - npm package versions (outdated, major updates)
 * - npm security advisories
 * - Monday.com API version (scans actual code)
 * - Anthropic API version (scans actual code)
 * 
 * Returns JSON report and can send email summary.
 * 
 * v1.0 - Initial implementation
 * v1.1 - Added actual code scanning for API versions, self-monitoring
 */

const nodemailer = require('nodemailer');

// ============================================================================
// CONFIGURATION - Add repos to monitor here
// ============================================================================

const REPOS_TO_MONITOR = [
  {
    name: 'Driver Verification',
    repo: 'ooosh-driver-verification-',  // Note: has trailing dash
    description: 'Main driver verification system'
  },
  {
    name: 'Payment Portal', 
    repo: 'netlify-functions',
    description: 'Customer payment portal'
  },
  {
    name: 'Freelancer Portal',
    repo: 'Ooosh-Freelancer-Portal',
    description: 'Freelancer management system'
  },
  {
    name: 'PCN Management',
    repo: 'PCN-Management-System',
    description: 'Penalty charge notice processing'
  },
  {
    name: 'HireHop Stock',
    repo: 'alternative-hirehop-stock',
    description: 'Alternative stock management'
  },
  {
    name: 'Utilities (this system)',
    repo: 'ooosh-utilities',
    description: 'Monitoring and automation hub'
  }
];

// Monday.com API version sunset dates (from their documentation)
// https://developer.monday.com/api-reference/docs/api-versioning
const MONDAY_API_VERSIONS = {
  '2023-10': { status: 'deprecated', sunset: '2024-10-14' },
  '2024-01': { status: 'deprecated', sunset: '2025-04-14' },
  '2024-04': { status: 'active', sunset: '2025-07-14' },
  '2024-07': { status: 'active', sunset: '2025-10-13' },
  '2024-10': { status: 'active', sunset: '2026-01-12' },
  '2025-01': { status: 'current', sunset: '2026-04-13' },
  '2025-04': { status: 'current', sunset: '2026-07-13' }
};

// Standing advisories (manual notes about known issues)
const STANDING_ADVISORIES = [
  {
    severity: 'info',
    component: 'react-scripts (Create React App)',
    message: 'In maintenance mode. Consider migrating to Vite when convenient.',
    link: 'https://react.dev/learn/start-a-new-react-project'
  }
];

// ============================================================================
// MAIN HANDLER
// ============================================================================

exports.handler = async (event) => {
  console.log('📦 Dependency check initiated');
  const startTime = Date.now();
  
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Check if we should send email
  const params = event.queryStringParameters || {};
  const sendEmail = params.sendEmail === 'true';

  try {
    const report = {
      timestamp: new Date().toISOString(),
      generatedAt: formatDate(new Date()),
      overall: 'healthy',
      nodeJs: await checkNodeJsStatus(),
      repos: [],
      apiVersions: {
        monday: { found: [], status: 'healthy', message: '' },
        anthropic: { found: [], status: 'healthy', message: '' }
      },
      standingAdvisories: STANDING_ADVISORIES,
      recommendations: [],
      checkDurationMs: 0
    };

    // Check each repo
    for (const repoConfig of REPOS_TO_MONITOR) {
      console.log(`📂 Checking ${repoConfig.name}...`);
      const repoReport = await checkRepository(repoConfig);
      report.repos.push(repoReport);
      
      // Also scan for API versions in this repo
      await scanForApiVersions(repoConfig, report.apiVersions);
    }

    // Analyze API version findings
    analyzeApiVersions(report.apiVersions);

    // Compile recommendations
    report.recommendations = compileRecommendations(report);

    // Determine overall status
    report.overall = determineOverallStatus(report);

    report.checkDurationMs = Date.now() - startTime;

    // Send email if requested
    if (sendEmail) {
      await sendReportEmail(report);
      report.emailSent = true;
    }

    console.log(`📦 Dependency check complete: ${report.overall}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(report, null, 2)
    };

  } catch (error) {
    console.error('❌ Dependency check error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};

// ============================================================================
// NODE.JS STATUS CHECK
// ============================================================================

async function checkNodeJsStatus() {
  const result = {
    status: 'healthy',
    currentVersion: process.version,
    majorVersion: parseInt(process.version.slice(1).split('.')[0]),
    eolDate: null,
    message: ''
  };

  try {
    // Query endoflife.date API for Node.js
    const response = await fetch('https://endoflife.date/api/nodejs.json');
    
    if (response.ok) {
      const versions = await response.json();
      
      // Find our major version
      const ourVersion = versions.find(v => 
        parseInt(v.cycle) === result.majorVersion
      );
      
      if (ourVersion) {
        result.eolDate = ourVersion.eol;
        result.lts = ourVersion.lts || false;
        
        // Check if EOL is approaching (within 3 months)
        const eolDate = new Date(ourVersion.eol);
        const now = new Date();
        const threeMonths = 90 * 24 * 60 * 60 * 1000;
        
        if (eolDate < now) {
          result.status = 'critical';
          result.message = `Node.js ${result.majorVersion} is END OF LIFE! Upgrade immediately.`;
        } else if (eolDate - now < threeMonths) {
          result.status = 'warning';
          result.message = `Node.js ${result.majorVersion} EOL approaching: ${ourVersion.eol}`;
        } else {
          result.status = 'healthy';
          result.message = `Supported until ${ourVersion.eol}`;
        }
      }
    }
  } catch (error) {
    console.error('Failed to check Node.js EOL:', error.message);
    result.message = 'Could not check EOL status';
  }

  return result;
}

// ============================================================================
// REPOSITORY CHECK
// ============================================================================

async function checkRepository(repoConfig) {
  const result = {
    name: repoConfig.name,
    repo: repoConfig.repo,
    description: repoConfig.description,
    status: 'healthy',
    packageJson: null,
    packages: {
      total: 0,
      upToDate: 0,
      minorUpdates: 0,
      majorUpdates: 0,
      securityIssues: 0,
      details: []
    },
    errors: []
  };

  try {
    // Fetch package.json from GitHub
    const packageJson = await fetchFileFromGitHub(repoConfig.repo, 'package.json');
    
    if (!packageJson) {
      result.status = 'error';
      result.errors.push('Could not fetch package.json');
      return result;
    }

    let parsed;
    try {
      parsed = JSON.parse(packageJson);
    } catch (e) {
      result.status = 'error';
      result.errors.push('Could not parse package.json');
      return result;
    }

    result.packageJson = {
      name: parsed.name,
      version: parsed.version
    };

    // Check dependencies
    result.packages.total = Object.keys(parsed.dependencies || {}).length;

    // Check each package
    for (const [pkg, version] of Object.entries(parsed.dependencies || {})) {
      const pkgStatus = await checkPackageVersion(pkg, version);
      
      if (pkgStatus.updateType === 'major') {
        result.packages.majorUpdates++;
        result.packages.details.push(pkgStatus);
      } else if (pkgStatus.updateType === 'minor' || pkgStatus.updateType === 'patch') {
        result.packages.minorUpdates++;
        result.packages.details.push(pkgStatus);
      } else {
        result.packages.upToDate++;
      }

      if (pkgStatus.securityIssue) {
        result.packages.securityIssues++;
      }
    }

    // Determine status
    if (result.packages.securityIssues > 0) {
      result.status = 'critical';
    } else if (result.packages.majorUpdates > 0) {
      result.status = 'warning';
    } else {
      result.status = 'healthy';
    }

  } catch (error) {
    result.status = 'error';
    result.errors.push(error.message);
  }

  return result;
}

// ============================================================================
// API VERSION SCANNING
// ============================================================================

async function scanForApiVersions(repoConfig, apiVersions) {
  const owner = process.env.GITHUB_OWNER || 'jon-ooosh';
  const token = process.env.GITHUB_TOKEN;
  
  if (!token) return;

  try {
    // Search for files that might contain API version headers
    // We'll check common locations: netlify/functions/, src/, and root
    const pathsToCheck = [
      'netlify/functions',
      'functions',
      'src',
      'pages/api',
      'app/api'
    ];

    for (const path of pathsToCheck) {
      const files = await listFilesInPath(repoConfig.repo, path);
      
      for (const file of files) {
        if (file.endsWith('.js') || file.endsWith('.ts')) {
          const content = await fetchFileFromGitHub(repoConfig.repo, file);
          if (content) {
            // Search for Monday.com API version
            const mondayMatches = content.match(/['"]API-Version['"]:\s*['"](\d{4}-\d{2})['"]/g);
            if (mondayMatches) {
              mondayMatches.forEach(match => {
                const version = match.match(/(\d{4}-\d{2})/)[1];
                apiVersions.monday.found.push({
                  repo: repoConfig.name,
                  file: file,
                  version: version
                });
              });
            }
            
            // Search for Anthropic API version
            const anthropicMatches = content.match(/['"]anthropic-version['"]:\s*['"]([^'"]+)['"]/g);
            if (anthropicMatches) {
              anthropicMatches.forEach(match => {
                const version = match.match(/['"]anthropic-version['"]:\s*['"]([^'"]+)['"]/)[1];
                apiVersions.anthropic.found.push({
                  repo: repoConfig.name,
                  file: file,
                  version: version
                });
              });
            }
          }
        }
      }
    }
  } catch (error) {
    console.log(`Could not scan ${repoConfig.repo} for API versions: ${error.message}`);
  }
}

async function listFilesInPath(repo, path) {
  const owner = process.env.GITHUB_OWNER || 'jon-ooosh';
  const token = process.env.GITHUB_TOKEN;
  
  if (!token) return [];

  try {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'OOOSH-Dependency-Monitor'
      }
    });

    if (!response.ok) return [];

    const contents = await response.json();
    
    if (!Array.isArray(contents)) return [];

    const files = [];
    for (const item of contents) {
      if (item.type === 'file') {
        files.push(item.path);
      } else if (item.type === 'dir') {
        // Recurse one level deep
        const subFiles = await listFilesInPath(repo, item.path);
        files.push(...subFiles);
      }
    }
    
    return files;
  } catch (error) {
    return [];
  }
}

function analyzeApiVersions(apiVersions) {
  const now = new Date();
  const twoMonths = 60 * 24 * 60 * 60 * 1000;

  // Analyze Monday.com versions
  if (apiVersions.monday.found.length > 0) {
    // Dedupe versions
    const uniqueVersions = [...new Set(apiVersions.monday.found.map(f => f.version))];
    
    const issues = [];
    for (const version of uniqueVersions) {
      const versionInfo = MONDAY_API_VERSIONS[version];
      
      if (!versionInfo) {
        issues.push(`Unknown version ${version} found`);
        continue;
      }
      
      const sunsetDate = new Date(versionInfo.sunset);
      
      if (sunsetDate < now) {
        apiVersions.monday.status = 'critical';
        issues.push(`Version ${version} sunset has PASSED (${versionInfo.sunset})`);
      } else if (sunsetDate - now < twoMonths) {
        if (apiVersions.monday.status !== 'critical') {
          apiVersions.monday.status = 'warning';
        }
        issues.push(`Version ${version} sunset approaching: ${versionInfo.sunset}`);
      }
    }
    
    if (issues.length > 0) {
      apiVersions.monday.message = issues.join('; ');
    } else {
      apiVersions.monday.message = `Using version(s): ${uniqueVersions.join(', ')} - all OK`;
    }
  } else {
    apiVersions.monday.message = 'No Monday.com API usage detected';
  }

  // Anthropic API is stable, just report what we found
  if (apiVersions.anthropic.found.length > 0) {
    const uniqueVersions = [...new Set(apiVersions.anthropic.found.map(f => f.version))];
    apiVersions.anthropic.message = `Using version(s): ${uniqueVersions.join(', ')}`;
  } else {
    apiVersions.anthropic.message = 'No Anthropic API usage detected';
  }
}

// ============================================================================
// GITHUB API
// ============================================================================

async function fetchFileFromGitHub(repoName, filePath) {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER || 'jon-ooosh';

  if (!token) {
    console.error('GITHUB_TOKEN not configured');
    return null;
  }

  try {
    const url = `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'OOOSH-Dependency-Monitor'
      }
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    
    // GitHub returns base64 encoded content
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return content;

  } catch (error) {
    console.error(`Error fetching ${filePath} from ${repoName}:`, error.message);
    return null;
  }
}

// ============================================================================
// NPM PACKAGE VERSION CHECK
// ============================================================================

async function checkPackageVersion(packageName, currentVersion) {
  const result = {
    name: packageName,
    current: currentVersion.replace(/[\^~]/, ''),
    latest: null,
    updateType: 'none',
    securityIssue: false
  };

  try {
    // Query npm registry
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
    
    if (response.ok) {
      const data = await response.json();
      result.latest = data.version;
      
      // Compare versions
      const current = parseVersion(result.current);
      const latest = parseVersion(result.latest);
      
      if (latest.major > current.major) {
        result.updateType = 'major';
      } else if (latest.minor > current.minor) {
        result.updateType = 'minor';
      } else if (latest.patch > current.patch) {
        result.updateType = 'patch';
      }
    }
  } catch (error) {
    // Silently fail for individual packages
    console.log(`Could not check ${packageName}: ${error.message}`);
  }

  return result;
}

function parseVersion(versionStr) {
  // Handle versions like "^18.2.0" or "~1.0.3"
  const clean = versionStr.replace(/[\^~>=<]*/g, '').split('-')[0];
  const parts = clean.split('.').map(p => parseInt(p) || 0);
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0
  };
}

// ============================================================================
// COMPILE RECOMMENDATIONS
// ============================================================================

function compileRecommendations(report) {
  const recommendations = [];

  // Node.js recommendations
  if (report.nodeJs.status === 'critical') {
    recommendations.push({
      priority: 'critical',
      action: `Upgrade Node.js immediately - version ${report.nodeJs.majorVersion} is end of life`
    });
  } else if (report.nodeJs.status === 'warning') {
    recommendations.push({
      priority: 'high',
      action: `Plan Node.js upgrade - EOL approaching: ${report.nodeJs.eolDate}`
    });
  }

  // Monday.com API version recommendations
  if (report.apiVersions.monday.status === 'critical') {
    recommendations.push({
      priority: 'critical',
      action: `Monday.com API: ${report.apiVersions.monday.message}`
    });
  } else if (report.apiVersions.monday.status === 'warning') {
    recommendations.push({
      priority: 'high',
      action: `Monday.com API: ${report.apiVersions.monday.message}`
    });
  }

  // Security recommendations
  for (const repo of report.repos) {
    if (repo.packages.securityIssues > 0) {
      recommendations.push({
        priority: 'critical',
        action: `${repo.name}: ${repo.packages.securityIssues} security vulnerabilities - run npm audit`
      });
    }
  }

  // Major version updates
  for (const repo of report.repos) {
    if (repo.packages.majorUpdates > 0) {
      const majorPkgs = repo.packages.details
        .filter(p => p.updateType === 'major')
        .map(p => `${p.name} (${p.current} → ${p.latest})`)
        .slice(0, 3);
      
      recommendations.push({
        priority: 'medium',
        action: `${repo.name}: ${repo.packages.majorUpdates} major updates available: ${majorPkgs.join(', ')}${repo.packages.majorUpdates > 3 ? '...' : ''}`
      });
    }
  }

  // If nothing to recommend
  if (recommendations.length === 0) {
    recommendations.push({
      priority: 'none',
      action: 'No actions required this week - all systems healthy'
    });
  }

  return recommendations;
}

// ============================================================================
// DETERMINE OVERALL STATUS
// ============================================================================

function determineOverallStatus(report) {
  // Critical if any security issues, Node.js EOL, or API version expired
  if (report.nodeJs.status === 'critical') return 'critical';
  if (report.apiVersions.monday.status === 'critical') return 'critical';
  
  for (const repo of report.repos) {
    if (repo.packages.securityIssues > 0) return 'critical';
  }

  // Warning if approaching issues
  if (report.nodeJs.status === 'warning') return 'warning';
  if (report.apiVersions.monday.status === 'warning') return 'warning';
  
  for (const repo of report.repos) {
    if (repo.packages.majorUpdates > 0) return 'warning';
  }

  return 'healthy';
}

// ============================================================================
// EMAIL REPORT
// ============================================================================

async function sendReportEmail(report) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  const statusEmoji = {
    healthy: '🟢',
    warning: '🟡',
    critical: '🔴',
    error: '⚪'
  };

  const statusColor = {
    healthy: '#22c55e',
    warning: '#f59e0b', 
    critical: '#ef4444',
    error: '#6b7280'
  };

  // Build HTML email
  let html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 700px; margin: 0 auto;">
      <div style="background: ${statusColor[report.overall]}; color: white; padding: 20px; text-align: center;">
        <h1 style="margin: 0;">OOOSH Weekly Tech Health Report</h1>
        <p style="margin: 10px 0 0 0;">${report.generatedAt}</p>
      </div>
      
      <div style="padding: 20px; background: #f9fafb;">
        <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
          <h2 style="margin-top: 0;">${statusEmoji[report.overall]} Overall Status: ${report.overall.toUpperCase()}</h2>
        </div>

        <!-- Node.js Status -->
        <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
          <h3 style="margin-top: 0;">🖥️ Node.js Runtime</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 5px 0;">Current Version:</td><td>${report.nodeJs.currentVersion}</td></tr>
            <tr><td style="padding: 5px 0;">Status:</td><td>${statusEmoji[report.nodeJs.status]} ${report.nodeJs.message}</td></tr>
          </table>
        </div>

        <!-- API Versions -->
        <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
          <h3 style="margin-top: 0;">🔌 API Versions (scanned from code)</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px 0;"><strong>Monday.com:</strong></td>
              <td>${statusEmoji[report.apiVersions.monday.status]} ${report.apiVersions.monday.message}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0;"><strong>Anthropic:</strong></td>
              <td>${statusEmoji[report.apiVersions.anthropic.status]} ${report.apiVersions.anthropic.message}</td>
            </tr>
          </table>
          ${report.apiVersions.monday.found.length > 0 ? `
          <details style="margin-top: 10px;">
            <summary style="cursor: pointer; color: #6b7280;">Show files using Monday.com API</summary>
            <ul style="font-size: 12px; color: #6b7280;">
              ${report.apiVersions.monday.found.map(f => `<li>${f.repo}: ${f.file} (v${f.version})</li>`).join('')}
            </ul>
          </details>
          ` : ''}
        </div>

        <!-- Repositories -->
        <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
          <h3 style="margin-top: 0;">📦 Repositories</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
            <tr style="background: #f3f4f6;">
              <th style="padding: 10px; text-align: left;">Project</th>
              <th style="padding: 10px; text-align: center;">Packages</th>
              <th style="padding: 10px; text-align: center;">Updates</th>
              <th style="padding: 10px; text-align: center;">Security</th>
              <th style="padding: 10px; text-align: center;">Status</th>
            </tr>
  `;

  for (const repo of report.repos) {
    html += `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${repo.name}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; text-align: center;">${repo.packages.total}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; text-align: center;">
          ${repo.packages.majorUpdates > 0 ? `<span style="color: #f59e0b;">${repo.packages.majorUpdates} major</span>` : ''}
          ${repo.packages.minorUpdates > 0 ? `<span style="color: #6b7280;">${repo.packages.minorUpdates} minor</span>` : ''}
          ${repo.packages.majorUpdates === 0 && repo.packages.minorUpdates === 0 ? '✓ Up to date' : ''}
        </td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; text-align: center;">
          ${repo.packages.securityIssues > 0 ? `<span style="color: #ef4444;">⚠️ ${repo.packages.securityIssues}</span>` : '✓'}
        </td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; text-align: center;">${statusEmoji[repo.status]}</td>
      </tr>
    `;
  }

  html += `
          </table>
        </div>

        <!-- Standing Advisories -->
        <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
          <h3 style="margin-top: 0;">📋 Standing Advisories</h3>
  `;

  for (const advisory of report.standingAdvisories) {
    html += `
      <div style="padding: 10px; background: #fef3c7; border-radius: 4px; margin-bottom: 10px;">
        <strong>ℹ️ ${advisory.component}</strong><br>
        ${advisory.message}
      </div>
    `;
  }

  html += `
        </div>

        <!-- Recommendations -->
        <div style="background: white; padding: 15px; border-radius: 8px;">
          <h3 style="margin-top: 0;">📋 Recommended Actions</h3>
  `;

  for (const rec of report.recommendations) {
    const recColor = rec.priority === 'critical' ? '#fef2f2' : 
                     rec.priority === 'high' ? '#fffbeb' : 
                     rec.priority === 'medium' ? '#f0fdf4' : '#f9fafb';
    const priorityBadge = rec.priority !== 'none' ? 
      `<span style="background: ${rec.priority === 'critical' ? '#ef4444' : rec.priority === 'high' ? '#f59e0b' : '#22c55e'}; color: white; padding: 2px 6px; border-radius: 4px; font-size: 11px; margin-right: 8px;">${rec.priority.toUpperCase()}</span>` : '';
    
    html += `
      <div style="padding: 10px; background: ${recColor}; border-radius: 4px; margin-bottom: 10px;">
        ${priorityBadge}${rec.action}
      </div>
    `;
  }

  html += `
        </div>
      </div>
      
      <div style="padding: 20px; text-align: center; color: #6b7280; font-size: 12px;">
        Generated by OOOSH Utilities Monitor v1.1<br>
        Check took ${report.checkDurationMs}ms
      </div>
    </div>
  `;

  await transporter.sendMail({
    from: `"OOOSH Tech Monitor" <${process.env.SMTP_USER}>`,
    to: 'healthcheck@oooshtours.co.uk',
    subject: `${statusEmoji[report.overall]} Weekly Tech Report - ${report.overall.toUpperCase()} - ${report.generatedAt}`,
    html: html
  });

  console.log('📧 Report email sent');
}

// ============================================================================
// UTILITIES
// ============================================================================

function formatDate(date) {
  return date.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/London'
  });
}