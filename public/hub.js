/**
 * OOOSH Staff Hub - Client-side JavaScript
 * 
 * Handles:
 * - PIN authentication
 * - Session management
 * - Tool launching with token handoff
 * - Job context management
 */ 

// ============================================
// TOOLS CONFIGURATION
// Add new tools here!
// ============================================

const TOOLS = [
  {
    id: 'crew-transport',
    name: 'Crew & Transport',
    description: 'Quote deliveries, collections & crewed jobs',
    icon: '🚛',
    baseUrl: 'https://ooosh-freelancer-portal.netlify.app/staff',
    requiresJob: true,
    jobParam: 'job'
  },
  {
    id: 'backline-matcher',
    name: 'Backline Matcher',
    description: 'Match equipment across jobs',
    icon: '🎸',
    baseUrl: 'https://alternative-hirehop-stock.netlify.app/app',
    requiresJob: false,
    jobParam: 'job'  // Will pass job if one is set, but not required
  },
  {
    id: 'payment-portal',
    name: 'Payment Portal',
    description: 'View customer payment page',
    icon: '💳',
    baseUrl: 'https://ooosh-tours-payment-page.netlify.app/payment.html',
    requiresJob: true,
    jobParam: 'jobId',
    },
  {
    id: 'admin-refund',
    name: 'Admin Refund',
    description: 'Process refunds and adjustments',
    icon: '💰',
    baseUrl: 'https://ooosh-tours-payment-page.netlify.app/admin',
    requiresJob: true,
    jobParam: 'job'
  },
  {
    id: 'warehouse',
    name: 'Warehouse Sign-out',
    description: 'Track equipment check-out',
    icon: '📦',
    baseUrl: 'https://ooosh-freelancer-portal.netlify.app/warehouse',
    requiresJob: false
  },
  {
    id: 'pcn-manager',
    name: 'PCN Manager',
    description: 'Penalty charge notice processing',
    icon: '🚗',
    baseUrl: 'https://ooosh-tours-pcn-management.netlify.app/index.html',
    requiresJob: false
  }
];

// ============================================
// STATE
// ============================================

let currentJobId = null;
let currentJobName = null;
let sessionToken = null;

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', () => {
  // Check for job ID in URL FIRST (before showing hub)
  const urlParams = new URLSearchParams(window.location.search);
  const jobFromUrl = urlParams.get('job');
  if (jobFromUrl) {
    currentJobId = jobFromUrl;
  }
  
  // Check for existing session
  sessionToken = localStorage.getItem('staffHubSession');
  const sessionExpiry = localStorage.getItem('staffHubSessionExpiry');
  
  // Check if session is still valid
  if (sessionToken && sessionExpiry && new Date(sessionExpiry) > new Date()) {
    showHub();
  } else {
    // Clear expired session
    localStorage.removeItem('staffHubSession');
    localStorage.removeItem('staffHubSessionExpiry');
    showLogin();
  }
  
  // Set up event listeners
  setupEventListeners();
});

function setupEventListeners() {
  // Login
  document.getElementById('login-btn').addEventListener('click', handleLogin);
  document.getElementById('pin-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleLogin();
  });
  
  // Job entry
  document.getElementById('set-job-btn').addEventListener('click', handleSetJob);
  document.getElementById('job-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSetJob();
  });
  
  // Change job
  document.getElementById('change-job-btn').addEventListener('click', () => {
    document.getElementById('job-entry').classList.remove('hidden');
    document.getElementById('job-input').focus();
  });
  
  // Logout
  document.getElementById('logout-btn').addEventListener('click', handleLogout);
}

// ============================================
// AUTHENTICATION
// ============================================

async function handleLogin() {
  const pin = document.getElementById('pin-input').value;
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  
  if (!pin) {
    errorEl.textContent = 'Please enter your PIN';
    return;
  }
  
  btn.disabled = true;
  btn.textContent = 'Checking...';
  errorEl.textContent = '';
  
  try {
    const response = await fetch('/.netlify/functions/staff-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin })
    });
    
    const data = await response.json();
    
    if (data.success) {
      // Store session (valid for 8 hours)
      sessionToken = data.sessionToken;
      const expiry = new Date(Date.now() + 8 * 60 * 60 * 1000);
      localStorage.setItem('staffHubSession', sessionToken);
      localStorage.setItem('staffHubSessionExpiry', expiry.toISOString());
      
      showHub();
    } else {
      errorEl.textContent = data.error || 'Invalid PIN';
    }
  } catch (error) {
    console.error('Login error:', error);
    errorEl.textContent = 'Connection error. Please try again.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enter Staff Hub';
  }
}

function handleLogout() {
  localStorage.removeItem('staffHubSession');
  localStorage.removeItem('staffHubSessionExpiry');
  sessionToken = null;
  currentJobId = null;
  document.getElementById('pin-input').value = '';
  showLogin();
}

// ============================================
// UI NAVIGATION
// ============================================

function showLogin() {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('hub-screen').classList.add('hidden');
  document.getElementById('pin-input').focus();
}

function showHub() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('hub-screen').classList.remove('hidden');
  
  // Update job display
  updateJobDisplay();
  
  // Render tools
  renderTools();
}

function updateJobDisplay() {
  const jobNumberEl = document.getElementById('job-number');
  const jobNameEl = document.getElementById('job-name');
  const jobEntryEl = document.getElementById('job-entry');
  
  if (currentJobId) {
    jobNumberEl.textContent = currentJobId;
    jobNameEl.textContent = currentJobName || '';
    jobEntryEl.classList.add('hidden');
    
    // Update URL without reload
    const url = new URL(window.location);
    url.searchParams.set('job', currentJobId);
    window.history.replaceState({}, '', url);
  } else {
    jobNumberEl.textContent = '—';
    jobNameEl.textContent = 'No job selected';
    jobEntryEl.classList.remove('hidden');
    document.getElementById('job-input').focus();
  }
  
  // Update tool cards (enable/disable based on job requirement)
  renderTools();
}

async function handleSetJob() {
  const jobInput = document.getElementById('job-input');
  const jobId = jobInput.value.trim();
  
  if (!jobId || !/^\d+$/.test(jobId)) {
    alert('Please enter a valid job number');
    return;
  }
  
  currentJobId = jobId;
  currentJobName = null; // Could fetch from HireHop if desired
  jobInput.value = '';
  updateJobDisplay();
}

// ============================================
// TOOLS RENDERING
// ============================================

function renderTools() {
  const grid = document.getElementById('tools-grid');
  grid.innerHTML = '';
  
  TOOLS.forEach(tool => {
    const card = document.createElement('a');
    card.className = 'tool-card';
    card.href = '#';
    
    // Check if tool is available
    const isDisabled = tool.requiresJob && !currentJobId;
    if (isDisabled) {
      card.classList.add('disabled');
    }
    
    card.innerHTML = `
      <div class="tool-icon">${tool.icon}</div>
      <div class="tool-name">${tool.name}</div>
      <div class="tool-description">${tool.description}</div>
      ${tool.requiresJob 
        ? '<span class="tool-badge requires-job">Requires job</span>'
        : '<span class="tool-badge no-job-needed">No job needed</span>'
      }
    `;
    
    card.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!isDisabled) {
        await launchTool(tool);
      }
    });
    
    grid.appendChild(card);
  });
}

// ============================================
// TOOL LAUNCHING
// ============================================

async function launchTool(tool) {
  // Show loading state
  const cards = document.querySelectorAll('.tool-card');
  cards.forEach(c => c.style.pointerEvents = 'none');
  
  try {
    // Generate handoff token
    const tokenResponse = await fetch('/.netlify/functions/generate-tool-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionToken,
        toolId: tool.id,
        jobId: currentJobId
      })
    });
    
    const tokenData = await tokenResponse.json();
    
    if (!tokenData.success) {
      alert('Session expired. Please log in again.');
      handleLogout();
      return;
    }
    
    // Build tool URL
    let url = tool.baseUrl;
    const params = new URLSearchParams();
    
    // Add job ID if required OR if tool accepts it optionally
    if (currentJobId && (tool.requiresJob || tool.jobParam)) {
      params.set(tool.jobParam || 'job', currentJobId);
    }
    
    // Handle special cases
    if (tool.special === 'payment-hash') {
      // Fetch hash from HireHop
      const hashResponse = await fetch('/.netlify/functions/get-payment-hash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionToken,
          jobId: currentJobId
        })
      });
      
      const hashData = await hashResponse.json();
      
      if (hashData.success) {
        params.set('hash', hashData.hash);
      } else {
        alert('Could not generate payment link: ' + (hashData.error || 'Unknown error'));
        return;
      }
    }
    
    // Add handoff token for tools that need it
    // (Payment portal doesn't need token - it's hash-based)
    if (tool.special !== 'payment-hash') {
      params.set('hubToken', tokenData.token);
    }
    
    // Build final URL
    if (params.toString()) {
      url += (url.includes('?') ? '&' : '?') + params.toString();
    }
    
    // Open in same tab or new tab based on preference
    window.open(url, '_blank');
    
  } catch (error) {
    console.error('Error launching tool:', error);
    alert('Error launching tool. Please try again.');
  } finally {
    cards.forEach(c => c.style.pointerEvents = '');
  }
}

