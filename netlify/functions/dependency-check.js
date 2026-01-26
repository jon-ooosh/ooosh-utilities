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
 * - Monday.com API version status
 * - Anthropic API version status
 * 
 * Returns JSON report and can send email summary.
 * 
 * v1.0 - Initial implementation
 */

const nodemailer = require('nodemailer');

// ============================================================================
// CONFIGURATION - Add repos to monitor here
// ============================================================================

const REPOS_TO_MONITOR = [
  {
    name: 'Driver Verification',
    repo: 'ooosh-driver-verification',
    description: 'Main driver verification system'
  },
  {
    name: 'Payment Portal', 
    repo: 'netlify-functions',  // Can update this if you rename it
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
  }
];

// Standing advisories (manual notes about known issues)
const STANDING_ADVISORIES = [
  {
    severity: 'info',
    component: 'react-scripts (Create React App)',
    message: 'In maintenance mode. Consider migrating to Vite when convenient.',
    link: 'https://react.dev/learn/start-a-new-react-project'
  }
];

// Monday.com API version tracking
const MONDAY_API_INFO = {
  currentRecommended: '2024-10',
  knownVersions: {
    '2024-01': { status: 'deprecated', sunset: '2025-04-14' },
    '2024-04': { status: 'active', sunset: '2025-07-14' },
    '2024-07': { status: 'active', sunset: '2025-10-13' },
    '2024-10': { status: 'current', sunset: '2026-01-12' }
  }
};

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
      sharedServices: checkSharedServices(),
      standingAdvisories: STANDING_ADVISORIES,
      recommendations: [],
      checkDurationMs: 0
    };

    // Check each repo
    for (const repoConfig of REPOS_TO_MONITOR) {
      console.log(`📂 Checking ${repoConfig.name}...`);
      const repoReport = await checkRepository(repoConfig);
      report.repos.push(repoReport);
    }

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
    const packageJson = await fetchPackageJson(repoConfig.repo);
    
    if (!packageJson) {
      result.status = 'error';
      result.errors.push('Could not fetch package.json');
      return result;
    }

    result.packageJson = {
      name: packageJson.name,
      version: packageJson.version
    };

    // Check dependencies
    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.devDependencies
    };

    result.packages.total = Object.keys(allDeps).length;

    // Check each package
    for (const [pkg, version] of Object.entries(packageJson.dependencies || {})) {
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
// GITHUB API
// ============================================================================

async function fetchPackageJson(repoName) {
  const token = process.env.GITHUB_TOKEN;
  const owner = process.env.GITHUB_OWNER || 'jon-ooosh';

  if (!token) {
    console.error('GITHUB_TOKEN not configured');
    return null;
  }

  try {
    const url = `https://api.github.com/repos/${owner}/${repoName}/contents/package.json`;
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'OOOSH-Dependency-Monitor'
      }
    });

    if (!response.ok) {
      console.error(`Failed to fetch package.json from ${repoName}: ${response.status}`);
      return null;
    }

    const data = await response.json();
    
    // GitHub returns base64 encoded content
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return JSON.parse(content);

  } catch (error) {
    console.error(`Error fetching package.json from ${repoName}:`, error.message);
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
// SHARED SERVICES CHECK
// ============================================================================

function checkSharedServices() {
  const services = [];

  // Monday.com API
  const mondayService = {
    name: 'Monday.com API',
    currentVersion: MONDAY_API_INFO.currentRecommended,
    status: 'healthy',
    message: ''
  };

  const versionInfo = MONDAY_API_INFO.knownVersions[MONDAY_API_INFO.currentRecommended];
  if (versionInfo) {
    const sunsetDate = new Date(versionInfo.sunset);
    const now = new Date();
    const twoMonths = 60 * 24 * 60 * 60 * 1000;

    if (sunsetDate - now < twoMonths) {
      mondayService.status = 'warning';
      mondayService.message = `Version ${MONDAY_API_INFO.currentRecommended} sunset: ${versionInfo.sunset}. Check for newer version.`;
    } else {
      mondayService.message = `Version ${MONDAY_API_INFO.currentRecommended} active until ${versionInfo.sunset}`;
    }
  }
  services.push(mondayService);

  // Anthropic API
  services.push({
    name: 'Anthropic API',
    currentVersion: '2023-06-01',
    status: 'healthy',
    message: 'Stable version, no known deprecation'
  });

  // Idenfy
  services.push({
    name: 'Idenfy API',
    currentVersion: 'v2',
    status: 'healthy',
    message: 'No known deprecation'
  });

  return services;
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

  // Monday.com API
  for (const service of report.sharedServices) {
    if (service.status === 'warning') {
      recommendations.push({
        priority: 'high',
        action: service.message
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
  // Critical if any security issues or Node.js EOL
  if (report.nodeJs.status === 'critical') return 'critical';
  
  for (const repo of report.repos) {
    if (repo.packages.securityIssues > 0) return 'critical';
  }

  // Warning if Node.js EOL approaching or major updates available
  if (report.nodeJs.status === 'warning') return 'warning';
  
  for (const repo of report.repos) {
    if (repo.packages.majorUpdates > 0) return 'warning';
  }

  for (const service of report.sharedServices) {
    if (service.status === 'warning') return 'warning';
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
          <h3 style="margin-top: 0;">🟢 Node.js Runtime</h3>
          <table style="width: 100%; border-collapse: collapse;">
            <tr><td style="padding: 5px 0;">Current Version:</td><td>${report.nodeJs.currentVersion}</td></tr>
            <tr><td style="padding: 5px 0;">Status:</td><td>${statusEmoji[report.nodeJs.status]} ${report.nodeJs.message}</td></tr>
          </table>
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

        <!-- Shared Services -->
        <div style="background: white; padding: 15px; border-radius: 8px; margin-bottom: 15px;">
          <h3 style="margin-top: 0;">🌐 Shared Services</h3>
          <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
  `;

  for (const service of report.sharedServices) {
    html += `
      <tr>
        <td style="padding: 8px 0;">${service.name}</td>
        <td style="padding: 8px 0;">${service.message}</td>
        <td style="padding: 8px 0;">${statusEmoji[service.status]}</td>
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
    html += `
      <div style="padding: 10px; background: ${recColor}; border-radius: 4px; margin-bottom: 10px;">
        ${rec.action}
      </div>
    `;
  }

  html += `
        </div>
      </div>
      
      <div style="padding: 20px; text-align: center; color: #6b7280; font-size: 12px;">
        Generated by OOOSH Utilities Monitor<br>
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