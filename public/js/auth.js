const Auth = {
  TOKEN_KEY: 'tarot_token',
  USER_KEY: 'tarot_user',

  getToken() {
    return localStorage.getItem(this.TOKEN_KEY);
  },

  setToken(token) {
    localStorage.setItem(this.TOKEN_KEY, token);
  },

  clearToken() {
    localStorage.removeItem(this.TOKEN_KEY);
    localStorage.removeItem(this.USER_KEY);
  },

  isLoggedIn() {
    return !!this.getToken();
  },

  getUser() {
    try {
      return JSON.parse(localStorage.getItem(this.USER_KEY));
    } catch {
      return null;
    }
  },

  setUser(user) {
    localStorage.setItem(this.USER_KEY, JSON.stringify(user));
  },

  logout() {
    this.clearToken();
    window.location.href = 'index.html';
  },

  async request(url, options = {}) {
    const token = this.getToken();
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const res = await fetch(url, { ...options, headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '请求失败', { cause: { status: res.status, code: data.code, email: data.email, lockout: data.lockout, lockoutEnds: data.lockoutEnds } });
    return data;
  },

  async register(email, password, username) {
    const data = await this.request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, username })
    });
    return data;
  },

  async login(login, password) {
    const data = await this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ login, password })
    });
    this.setToken(data.token);
    this.setUser(data.user);
    return data;
  },

  async getMe() {
    const data = await this.request('/api/auth/me');
    this.setUser(data.user);
    return data.user;
  },

  async forgotPassword(email) {
    return await this.request('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
  },

  async resetPassword(token, password) {
    return await this.request('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password })
    });
  },

  async verifyEmail(token) {
    return await this.request('/api/auth/verify-email?token=' + encodeURIComponent(token));
  },

  async resendVerify(email) {
    return await this.request('/api/auth/resend-verification', {
      method: 'POST',
      body: JSON.stringify({ email })
    });
  },

  async checkEmailCooldown(email, type) {
    try {
      const res = await fetch('/api/auth/email-cooldown?email=' + encodeURIComponent(email) + '&type=' + (type || 'verify'));
      const data = await res.json();
      return data.remaining || 0;
    } catch { return 0; }
  },

  async getCreditTransactions(page, limit) {
    return await this.request('/api/user/credit-transactions?page=' + (page || 1) + '&limit=' + (limit || 20));
  },

  async getCredits() {
    return await this.request('/api/user/credits');
  },

  async redeem(code) {
    return await this.request('/api/user/redeem', {
      method: 'POST',
      body: JSON.stringify({ code })
    });
  },

  async getHistory(page, limit) {
    return await this.request('/api/user/history?page=' + (page || 1) + '&limit=' + (limit || 20));
  },

  async getHistoryDetail(id) {
    return await this.request('/api/user/history/' + id);
  },

  async deleteHistory(id) {
    return await this.request('/api/user/history/' + id, {
      method: 'DELETE'
    });
  },

  async updateUsername(username) {
    return await this.request('/api/user/update-username', {
      method: 'PUT',
      body: JSON.stringify({ username })
    });
  },

  async deleteAccount(password) {
    const data = await this.request('/api/user/delete-account', {
      method: 'DELETE',
      body: JSON.stringify({ password })
    });
    this.clearToken();
    return data;
  }
};
