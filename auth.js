const AUTH_BACKEND = 'https://coverwhale-auth.vercel.app';

class CoverWhaleAuth {
  constructor() {
    this.token = localStorage.getItem('cw_auth_token');
    this.user = null;
  }
  
  async init() {
    // Check if token in URL (from OAuth redirect)
    const urlParams = new URLSearchParams(window.location.search);
    const tokenFromUrl = urlParams.get('token');
    
    if (tokenFromUrl) {
      this.token = tokenFromUrl;
      localStorage.setItem('cw_auth_token', tokenFromUrl);
      // Clean URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }
    
    // Verify token
    if (this.token) {
      const isValid = await this.verifyToken();
      if (!isValid) {
        this.login();
        return false;
      }
      return true;
    } else {
      this.login();
      return false;
    }
  }
  
  async verifyToken() {
    try {
      const response = await fetch(`${AUTH_BACKEND}/api/verify`, {
        headers: { 'Authorization': `Bearer ${this.token}` }
      });
      
      if (response.ok) {
        const data = await response.json();
        this.user = data.user;
        return true;
      }
      return false;
    } catch (error) {
      console.error('Token verification failed:', error);
      return false;
    }
  }
  
  login() {
    const returnUrl = encodeURIComponent(window.location.origin + window.location.pathname);
    window.location.href = `${AUTH_BACKEND}/api/auth?return_url=${returnUrl}`;
  }
  
  logout() {
    localStorage.removeItem('cw_auth_token');
    this.token = null;
    this.user = null;
    window.location.reload();
  }
  
  getUser() {
    return this.user;
  }
}

// Initialize auth
const auth = new CoverWhaleAuth()
  // Token expires after 24h, auto-refresh if needed
setInterval(() => {
  auth.verifyToken().then(valid => {
    if (!valid) auth.login();
  });
}, 60 * 60 * 1000); // Check every hour;
