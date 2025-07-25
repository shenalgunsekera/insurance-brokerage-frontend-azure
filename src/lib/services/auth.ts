'use client';

import axios from 'axios';
import { jwtDecode } from 'jwt-decode';
import Cookies from 'js-cookie';

// Use the new Choreo API configuration
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:5000/api';
const API_TOKEN = process.env.NEXT_PUBLIC_API_TOKEN || '';
const TOKEN_COOKIE_NAME = 'token';
const USER_STORAGE_KEY = 'user_data';
const TOKEN_EXPIRY_DAYS = 7;
const CSRF_TOKEN_HEADER = 'X-CSRF-Token';
const API_TIMEOUT = 60000; // 8 seconds timeout for API requests

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface User {
  id: number;
  email: string;
  firstName: string;
  lastName: string;
  role: 'admin' | 'manager';
}

export interface AuthResponse {
  token: string;
  user: User;
}

interface JWTPayload {
  userId: number;
  role: string;
  exp: number;
}

class AuthService {
  private csrfToken: string | null = null;

  constructor() {
    this.setupAxiosInterceptors();
    // Set the API token for Choreo deployment
    if (API_TOKEN && typeof window !== 'undefined') {
      axios.defaults.headers.common['Authorization'] = `Bearer ${API_TOKEN}`;
    }
  }

  private setupAxiosInterceptors() {
    // Add CSRF token to all requests
    axios.interceptors.request.use((config) => {
      if (this.csrfToken && config.headers) {
        config.headers[CSRF_TOKEN_HEADER] = this.csrfToken;
      }
      return config;
    });

    // Handle 401 (Unauthorized) responses globally
    axios.interceptors.response.use(
      (response) => response,
      (error) => {
        if (error.response && error.response.status === 401) {
          // If 401 received, clear tokens and redirect to login
          this.clearAuthToken();
          if (typeof window !== 'undefined') {
            window.location.href = '/login';
          }
        }
        return Promise.reject(error);
      }
    );
  }

  private setAuthToken(token: string, rememberMe = false) {
    if (typeof window !== 'undefined') {
      // Set token in cookie with appropriate expiry
      const expiryDays = rememberMe ? TOKEN_EXPIRY_DAYS : null; // null means session cookie
      Cookies.set(TOKEN_COOKIE_NAME, token, { 
        expires: expiryDays ? expiryDays : undefined,
        secure: process.env.NODE_ENV === 'production', 
        sameSite: 'strict',
        httpOnly: false // Note: Client-side cookies can't be httpOnly
      });
      
      // Set token in localStorage as backup
      localStorage.setItem(TOKEN_COOKIE_NAME, token);
      
      // Set axios default header
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;

      // Extract CSRF token from JWT
      try {
        const decoded = jwtDecode<JWTPayload>(token);
        // In a real app, your JWT should contain a csrf claim
        this.csrfToken = decoded.userId.toString() + '.' + Math.random().toString(36).substring(2);
      } catch (error) {
        // Silent error, failsafe approach
        this.csrfToken = null;
      }
    }
  }

  private clearAuthToken() {
    if (typeof window !== 'undefined') {
      Cookies.remove(TOKEN_COOKIE_NAME);
      localStorage.removeItem(TOKEN_COOKIE_NAME);
      localStorage.removeItem(USER_STORAGE_KEY);
      delete axios.defaults.headers.common['Authorization'];
      this.csrfToken = null;
    }
  }

  async login(credentials: LoginCredentials, rememberMe = false): Promise<AuthResponse> {
    try {
      // Check if credentials are in the URL, which is a security risk
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        if (url.searchParams.has('email') || url.searchParams.has('password')) {
          // Remove credentials from URL
          url.searchParams.delete('email');
          url.searchParams.delete('password');
          window.history.replaceState({}, document.title, url.toString());
        }
      }

      const response = await axios.post<AuthResponse>(
        `${API_BASE}/auth/login`, 
        credentials,
        { timeout: API_TIMEOUT }
      );
      
      const { token, user } = response.data;
      
      this.setAuthToken(token, rememberMe);
      
      if (typeof window !== 'undefined') {
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
      }
      
      return response.data;
    } catch (error: any) {
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        const status = error.response.status;
        const message = error.response.data?.message || 'Unknown error';
        
        if (status === 401) {
          throw new Error('Invalid credentials. Please check your email and password.');
        } else if (status === 403) {
          throw new Error('Your account is not active. Please contact administrator.');
        } else {
          throw new Error(`Login failed (${status}): ${message}`);
        }
      } else if (error.request) {
        // The request was made but no response was received
        throw new Error('No response from server. Please check your connection and try again.');
      } else {
        // Something happened in setting up the request that triggered an Error
        throw new Error('Login failed. Please try again later.');
      }
    }
  }

  async getCurrentUser(): Promise<User> {
    try {
      // Initialize authorization header with token
      const token = this.getToken();
      if (token) {
        axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      } else if (API_TOKEN) {
        // If no user token, use the API token for Choreo
        axios.defaults.headers.common['Authorization'] = `Bearer ${API_TOKEN}`;
      }
      
      const response = await axios.get<User>(
        `${API_BASE}/auth/me`,
        { timeout: API_TIMEOUT }
      );
      
      const user = response.data;
      
      if (typeof window !== 'undefined') {
        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
      }
      
      return user;
    } catch (error: any) {
      // If 401, clear token
      if (error.response && error.response.status === 401) {
        this.clearAuthToken();
      }
      throw new Error('Failed to fetch user data');
    }
  }

  logout() {
    // Perform a server-side logout if your API supports it
    try {
      if (this.isAuthenticated()) {
        axios.post(`${API_BASE}/auth/logout`, {})
          .catch(() => {}); // Silently catch errors on logout
      }
    } finally {
      this.clearAuthToken();
      // Set the API token for Choreo if available
      if (API_TOKEN) {
        axios.defaults.headers.common['Authorization'] = `Bearer ${API_TOKEN}`;
      }
    }
  }

  isAuthenticated(): boolean {
    if (typeof window === 'undefined') return false;
    
    const token = this.getToken();
    if (!token) return false;
    
    try {
      const decoded = jwtDecode<JWTPayload>(token);
      const currentTime = Math.floor(Date.now() / 1000);
      
      // Check if token is expired
      if (decoded.exp < currentTime) {
        this.clearAuthToken();
        return false;
      }
      
      return true;
    } catch (error) {
      this.clearAuthToken();
      return false;
    }
  }

  getToken(): string | null {
    if (typeof window === 'undefined') return null;
    
    // Try to get token from cookie first
    const tokenFromCookie = Cookies.get(TOKEN_COOKIE_NAME);
    if (tokenFromCookie) return tokenFromCookie;
    
    // Fall back to localStorage if cookie is not available
    return localStorage.getItem(TOKEN_COOKIE_NAME);
  }

  getStoredUser(): User | null {
    if (typeof window === 'undefined') return null;
    
    const userStr = localStorage.getItem(USER_STORAGE_KEY);
    return userStr ? JSON.parse(userStr) : null;
  }

  getUserRole(): string | null {
    const token = this.getToken();
    if (!token) return null;
    
    try {
      const decoded = jwtDecode<JWTPayload>(token);
      return decoded.role;
    } catch {
      return null;
    }
  }

  // Get dashboard path for the current user's role
  getDashboardPath(): string {
    const role = this.getUserRole();
    switch (role) {
      case 'admin': return '/admin/dashboard';
      case 'manager': return '/manager-dashboard';
      default: return '/';
    }
  }
}

export const authService = new AuthService(); 