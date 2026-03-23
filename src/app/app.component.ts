import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewInit, ViewChildren, QueryList, ChangeDetectionStrategy, ChangeDetectorRef } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Chart, registerables } from 'chart.js';
import { getCurrentWindow, PhysicalSize } from "@tauri-apps/api/window";
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
// web-llm is loaded lazily on demand to avoid crash at startup
type WebLLMModule = typeof import('@mlc-ai/web-llm');

const appWindow = getCurrentWindow();

Chart.register(...registerables);

interface Alert {
  id: string;
  type: 'warning' | 'critical' | 'info';
  title: string;
  message: string;
  timestamp: number;
}

interface Advice {
  id: string;
  severity: 'critical' | 'warning' | 'info' | 'good';
  icon: string;
  title: string;
  message: string;
  action?: string;
}

interface DiskInfo {
  name: string;
  total_space: number;
  available_space: number;
  kind: string;
}

interface ComponentInfo {
  label: string;
  temp: number | null;
  max_temp: number | null;
  critical_temp: number | null;
}

interface BatteryStats {
  percentage: number;
  is_charging: boolean;
  status: string;
  time_remaining: number | null;
  health: number | null;
  power_usage: number | null;
  cycle_count: number | null;
}

interface ServiceInfo {
  name: string;
  display_name: string;
  status: string;
}

interface StartupInfo {
  name: string;
  command: string;
  location: string;
}

interface PortInfo {
  port: number;
  protocol: string;
  pid: number;
  process_name: string;
  state: string;
}

interface DevServerInfo {
  framework: string;
  url: string;
  port: number;
  pid: number;
  process_name: string;
  status: string;
}

interface ProcessInfo {
  pid: number;
  parent_pid: number | null;
  name: string;
  cpu_usage: number;
  memory: number;
  run_duration: number; // in seconds
  status: string;
  exe_path: string;
  isFavorite?: boolean;
  children?: ProcessInfo[];
  isExpanded?: boolean;
}

interface DockerContainer {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  ports: string;
}

interface DbServerInfo {
  name: string;
  port: number;
  status: string;
  pid: number | null;
  uptime: number;
}

interface EnvironmentInfo {
  node_version: string;
  python_version: string;
  rust_version: string;
  git_version: string;
  java_version: string;
  go_version: string;
  dotnet_version: string;
  php_version: string;
  os_details: string;
  shell_type: string;
  env_vars: { [key: string]: string };
}


interface DevAdvice {
  id: string;
  severity: 'warning' | 'info' | 'critical';
  title: string;
  message: string;
  icon: string;
}

type ProcessSortKey = 'name' | 'cpu_usage' | 'memory' | 'pid';

interface SystemStats {
  cpu_usage: number;
  cpu_cores: number;
  physical_cores: number;
  cpu_model: string;
  cpu_arch: string;
  cpu_freq: number;
  cpus: number[];
  cpu_temp: number | null;
  memory_used: number;
  memory_total: number;
  os_name: string;
  os_version: string;
  uptime: number;
  disks: DiskInfo[];
  net_received: number;
  net_transmitted: number;
  processes: ProcessInfo[];
  gpu_name: string;
  gpu_usage: number;
  gpu_temp: number | null;
  gpu_clock: number | null;
  gpu_fan_speed: number | null;
  vram_used: number;
  vram_total: number;
  battery: BatteryStats | null;
  disk_read_speed: number;
  disk_write_speed: number;
  ping: number;
  wifi_signal: number;
  load_average: number[];
  memory_free: number;
  memory_available: number;
  swap_total: number;
  swap_used: number;
  sensors: ComponentInfo[];
  local_ip: string;
  active_connections: number;
  last_boot_time: number;
  health_score: number;
  crash_reports_count: number;
}

interface UsageLog {
  id?: number;
  userId: string;
  feature: string;
  duration: number;
  createdAt: number;
}


interface DailyUsage {
  feature: string;
  totalDuration: number;
}

interface WeeklyTrend {
  date: string;
  totalDuration: number;
}

interface AppLimit {
  feature: string;
  dailyLimit: number; // seconds
  restrictionType: 'soft' | 'hard';
}


@Component({
  selector: "app-root",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class AppComponent implements OnInit, OnDestroy, AfterViewInit {
  constructor(private cdr: ChangeDetectorRef) { }
  public Math = Math;
  public Date = Date;

  @ViewChild('cpuCanvas') cpuCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('memoryCanvas') memoryCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChildren('coreCanvas') coreCanvases!: QueryList<ElementRef<HTMLCanvasElement>>;
  @ViewChild('gpuCanvas') gpuCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('pingCanvas') pingCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('netTrafficCanvas') netTrafficCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('diskIOHistoryCanvas') diskIOHistoryCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('dailyUsageCanvas') dailyUsageCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('weeklyTrendCanvas') weeklyTrendCanvas!: ElementRef<HTMLCanvasElement>;

  systemStats: SystemStats | null = null;
  interval: any;
  appStartTime = Date.now();
  isAppReady = false;
  appVersion = "1.0.4";
  isCheckingUpdate = false;
  isUpdateAvailable = false;
  updateData: any = null;
  updateStatus: 'idle' | 'checking' | 'available' | 'uptodate' | 'error' | 'downloading' | 'installing' = 'idle';
  updateErrorMsg = '';

  async checkUpdates(silent = false) {
    if (this.updateStatus === 'checking' || this.updateStatus === 'downloading') return;

    try {
      this.isCheckingUpdate = true;
      this.updateStatus = 'checking';
      this.updateErrorMsg = '';
      this.cdr.markForCheck();

      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();

      if (update) {
        this.updateData = update;
        this.isUpdateAvailable = true;
        this.updateStatus = 'available';
      } else {
        this.updateStatus = 'uptodate';
        if (!silent) {
          setTimeout(() => {
            this.updateStatus = 'idle';
            this.cdr.markForCheck();
          }, 3000);
        }
      }
    } catch (e: any) {
      console.error("Update check failed", e);
      this.updateStatus = 'error';
      this.updateErrorMsg = e?.message || String(e);
    } finally {
      this.isCheckingUpdate = false;
      this.cdr.markForCheck();
    }
  }

  async installUpdate() {
    if (!this.updateData) return;
    try {
      this.updateStatus = 'downloading';
      this.cdr.markForCheck();
      await this.updateData.downloadAndInstall();
      // App will relaunch automatically
    } catch (e: any) {
      this.updateStatus = 'error';
      this.updateErrorMsg = "Installation failed: " + (e?.message || String(e));
      this.cdr.markForCheck();
    }
  }

  closeUpdateModal() {
    this.isUpdateAvailable = false;
    this.updateStatus = 'idle';
    this.cdr.markForCheck();
  }

  cpuChart: Chart | null = null;
  memoryChart: Chart | null = null;
  gpuChart: Chart | null = null;
  pingChart: Chart | null = null;
  netTrafficChart: Chart | null = null;
  diskIOChart: Chart | null = null;
  coreCharts: Chart[] = [];

  readonly HISTORY_LIMIT = 60; // 1 minute of history
  cpuHistory: number[] = new Array(60).fill(0);
  memoryHistory: number[] = new Array(60).fill(0);
  gpuHistory: number[] = new Array(60).fill(0);
  pingHistory: number[] = new Array(60).fill(0);
  netDownHistory: number[] = new Array(60).fill(0);
  netUpHistory: number[] = new Array(60).fill(0);
  diskReadHistory: number[] = new Array(60).fill(0);
  diskWriteHistory: number[] = new Array(60).fill(0);
  coreHistories: number[][] = [];

  // App Usage Tracking
  appUsageMap: Map<string, number> = new Map(); // name -> seconds
  topAppsUsage: { name: string, time: number }[] = [];

  lastNetReceived = 0;
  lastNetTransmitted = 0;
  netSpeedIn = 0; // Bytes per second
  netSpeedOut = 0; // Bytes per second

  // Process Management State
  searchTerm = '';
  sortKey: ProcessSortKey = 'cpu_usage';
  sortDir: 'asc' | 'desc' = 'desc';
  favorites: Set<number> = new Set();
  expandedParents: Set<number> = new Set();
  showTree = false;

  // Management State
  activeTab: 'dashboard' | 'performance' | 'processes' | 'management' | 'advisor' | 'reports' | 'dev' | 'gaming' | 'analytics' = 'dashboard';
  lastTabChangeTime = Date.now();
  windowFocusStartTime = Date.now();
  userId = 'default_user'; // Could be fetched from a service later
  usageLogs: UsageLog[] = [];
  dailyUsage: DailyUsage[] = [];
  weeklyTrends: WeeklyTrend[] = [];
  totalDailyTime = 0;
  aggregatedUsage: { feature: string, duration: number }[] = [];

  dailyUsageChart: Chart | null = null;
  weeklyTrendChart: Chart | null = null;

  usageLimits: AppLimit[] = [];
  showLimitReachedModal = false;
  showLimitWarningModal = false;
  reachedLimit: AppLimit | null = null;
  warningLimit: AppLimit | null = null;
  limitFormVisible = false;
  newLimitFeature = '';
  newLimitMins = 60;
  newLimitType: 'soft' | 'hard' = 'soft';

  lastMgmtRefresh = 0;
  isLoadingMgmt = false;
  mgmtSubTab: 'services' | 'startup' = 'services';
  devSubTab: 'ports' | 'servers' | 'coding' | 'docker' | 'db' | 'env' = 'ports';
  services: ServiceInfo[] = [];
  startupApps: StartupInfo[] = [];
  activePorts: PortInfo[] = [];
  p_filteredPorts: PortInfo[] = [];
  devServers: DevServerInfo[] = [];
  p_filteredDevServers: DevServerInfo[] = [];
  codingProcesses: ProcessInfo[] = [];
  p_filteredCodingProcesses: ProcessInfo[] = [];
  dockerContainers: DockerContainer[] = [];
  p_filteredDockerContainers: DockerContainer[] = [];
  dbServers: DbServerInfo[] = [];
  p_filteredDbServers: DbServerInfo[] = [];
  environmentInfo: EnvironmentInfo | null = null;
  envSearchTerm: string = '';
  filteredEnvVars: { key: string, value: string }[] = [];

  isLoadingPorts = false;
  isLoadingServers = false;
  isLoadingCoding = false;
  isLoadingDocker = false;
  isLoadingDb = false;
  isLoadingEnv = false;
  lastPortsRefresh = 0;
  managementSearchTerm = '';

  // Gaming Performance State
  isGamingBoostActive = false;
  fpsValue = 0;
  lastFrameTime = 0;
  frameTimeHistory: number[] = new Array(60).fill(0);
  isOverlayActive = false;
  isBoosting = false;
  gamingChart: Chart | null = null;
  @ViewChild('frameTimeCanvas') frameTimeCanvas!: ElementRef<HTMLCanvasElement>;

  // Cached Filtered Lists
  p_filteredProcesses: ProcessInfo[] = [];
  p_filteredServices: ServiceInfo[] = [];
  p_filteredStartupApps: StartupInfo[] = [];

  get uniqueProcessNames(): string[] {
    if (!this.systemStats) return [];
    return Array.from(new Set(this.systemStats.processes.map(p => p.name))).sort((a,b) => a.localeCompare(b));
  }

  // Dev Advisor State
  devAdvices: DevAdvice[] = [];

  // Alerts State
  alerts: Alert[] = [];
  alertThresholds = {
    cpu: 90,
    ram: 90,
    temp: 85,
    disk: 95
  };

  // Sidebar & Theme State
  isDarkMode = true;
  isMiniMode = false;
  isAlwaysOnTop = false;
  isSidebarCollapsed = false;

  // AI Advisor State
  isAdvisorOpen = false;
  advices: Advice[] = [];
  advisorLastRun = 0;
  advisorScore = 100; // 0–100 health score

  // LLM Advisor State
  advisorMode: 'rule' | 'llm' = 'rule'; // which mode is active
  llmEngine: any | null = null; // MLCEngine – typed as any since we use dynamic import
  llmStatus: 'idle' | 'loading' | 'ready' | 'thinking' | 'error' = 'idle';
  llmProgress = 0; // 0–100 load progress
  llmProgressText = '';
  llmError = '';
  llmResponse = ''; // raw streaming response
  selectedModel = 'Llama-3.2-1B-Instruct-q4f16_1-MLC';
  readonly AVAILABLE_MODELS = [
    { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'LLaMA 3.2 1B (Fast, ~0.6 GB)' },
    { id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC', label: 'LLaMA 3.2 3B (Smarter, ~1.8 GB)' },
    { id: 'Phi-3.5-mini-instruct-q4f16_1-MLC', label: 'Phi 3.5 Mini (Balanced, ~2.0 GB)' },
    { id: 'gemma-2-2b-it-q4f16_1-MLC', label: 'Gemma 2 2B (Google, ~1.5 GB)' },
    { id: 'Mistral-7B-Instruct-v0.3-q4f16_1-MLC', label: 'Mistral 7B (Powerful, ~4.0 GB)' },
  ];

  // Customizable Dashboard (Widget Visibility)
  widgetVisibility = {
    cpu: true,
    cores: true,
    ram: true,
    gpu: true,
    net: true,
    disk: true,
    conn: true,
    usage: true,
    info: true,
    processes: true,
    hogs: true
  };

  topHogs: ProcessInfo[] = [];

  publicIp: string = 'Detecting...';


  async ngOnInit() {
    // Initial fetch
    await this.fetchStats();
    this.fetchPublicIp();
    this.fetchUsageLogs();
    this.fetchUsageLimits();

    // Listen for limit events from backend
    listen<AppLimit>('limit_reached', (event: any) => {
      this.reachedLimit = event.payload;
      this.showLimitReachedModal = true;
      this.showLimitWarningModal = false; // Close warning if reached hit
      this.cdr.markForCheck();
    });

    listen<AppLimit>('limit_warning', (event: any) => {
      // Only show warning if reached hasn't been shown
      if (!this.showLimitReachedModal) {
        this.warningLimit = event.payload;
        this.showLimitWarningModal = true;
        this.cdr.markForCheck();
      }
    });

    // Minimum splash duration 2.5s
    setTimeout(() => {
      this.isAppReady = true;
      this.cdr.markForCheck();
    }, 2500);

    this.interval = setInterval(() => {
      this.fetchStats();
      const now = Date.now();
      if (this.activeTab === 'management' && !this.isLoadingMgmt && (now - this.lastMgmtRefresh > 5000)) {
        this.refreshManagementData();
      }
      // Run advisor every 10 seconds
      if (now - this.advisorLastRun > 10000) {
        if (this.systemStats) this.runAdvisor(this.systemStats);
        this.advisorLastRun = now;
      }
      this.cdr.markForCheck(); // Trigger manual CD update
    }, 1000);
  }





  async fetchUsageLogs() {
    try {
      this.usageLogs = await invoke<UsageLog[]>('get_usage_logs');
      await this.fetchDailyUsage();
      this.processAggregatedUsage();
      this.cdr.markForCheck();
    } catch (e) {
      console.error("Failed to fetch usage logs", e);
    }
  }

  async fetchDailyUsage() {
    try {
      this.dailyUsage = await invoke<DailyUsage[]>('get_daily_usage');
      this.totalDailyTime = this.dailyUsage.reduce((acc, curr) => acc + curr.totalDuration, 0);
      if (this.dailyUsageChart) {
        this.dailyUsageChart.data.labels = this.dailyUsage.slice(0, 8).map(u => u.feature);
        this.dailyUsageChart.data.datasets[0].data = this.dailyUsage.slice(0, 8).map(u => u.totalDuration / 60); // mins
        this.dailyUsageChart.update();
      }
    } catch (e) {
      console.error("Failed to fetch daily usage", e);
    }
  }

  async fetchWeeklyTrends() {
    try {
      this.weeklyTrends = await invoke<WeeklyTrend[]>('get_weekly_trends');
      console.log('Weekly Trends:', this.weeklyTrends);
      if (this.weeklyTrendChart) {
        this.weeklyTrendChart.data.labels = this.weeklyTrends.map(t => {
           const date = new Date(t.date);
           return date.toLocaleDateString(undefined, { weekday: 'short' });
        });
        this.weeklyTrendChart.data.datasets[0].data = this.weeklyTrends.map(t => t.totalDuration / 3600); // hours
        this.weeklyTrendChart.update();
      }
    } catch (e) {
      console.error("Failed to fetch weekly trends", e);
    }
  }

  async fetchUsageLimits() {
    try {
      this.usageLimits = await invoke<AppLimit[]>('get_usage_limits');
    } catch (e) {
      console.error("Failed to fetch usage limits", e);
    }
  }

  async saveUsageLimit() {
    if (!this.newLimitFeature) return;
    try {
      const limitSeconds = this.newLimitMins * 60;
      await invoke('save_usage_limit', { 
        feature: this.newLimitFeature, 
        dailyLimit: limitSeconds,
        restrictionType: this.newLimitType 
      });
      this.newLimitFeature = '';
      this.newLimitType = 'soft';
      this.limitFormVisible = false;
      this.fetchUsageLimits();
    } catch (e) {
      console.error("Failed to save usage limit", e);
    }
  }

  async deleteUsageLimit(email: string) { // Wait, why email? Ah, it's feature name
    try {
      await invoke('delete_usage_limit', { feature: email });
      this.fetchUsageLimits();
    } catch (e) {
      console.error("Failed to delete usage limit", e);
    }
  }

  initAnalyticsCharts() {
    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#888', font: { size: 10 } } },
          y: { 
            beginAtZero: true, 
            grid: { color: 'rgba(255, 255, 255, 0.05)' }, 
            ticks: { color: '#888', font: { size: 10 } } 
          }
        }
    };

    if (this.dailyUsageCanvas) {
        if (this.dailyUsageChart) this.dailyUsageChart.destroy();
        this.dailyUsageChart = new Chart(this.dailyUsageCanvas.nativeElement, {
            type: 'bar',
            data: {
                labels: this.dailyUsage.slice(0, 8).map(u => u.feature),
                datasets: [{
                    data: this.dailyUsage.slice(0, 8).map(u => u.totalDuration / 60),
                    backgroundColor: 'rgba(96, 205, 255, 0.6)',
                    borderColor: '#60CDFF',
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: { ...commonOptions, indexAxis: 'y' } as any
        });
    }

    if (this.weeklyTrendCanvas) {
        if (this.weeklyTrendChart) this.weeklyTrendChart.destroy();
        this.weeklyTrendChart = new Chart(this.weeklyTrendCanvas.nativeElement, {
            type: 'line',
            data: {
                labels: this.weeklyTrends.map(t => {
                   const date = new Date(t.date);
                   return date.toLocaleDateString(undefined, { weekday: 'short' });
                }),
                datasets: [{
                    data: this.weeklyTrends.map(t => t.totalDuration / 3600),
                    borderColor: '#B56CFF',
                    backgroundColor: 'rgba(181, 108, 255, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    pointBackgroundColor: '#B56CFF'
                }]
            },
            options: commonOptions
        });
    }
  }


  processAggregatedUsage() {
    const map = new Map<string, number>();
    this.usageLogs.forEach(log => {
      const current = map.get(log.feature) || 0;
      map.set(log.feature, current + log.duration);
    });

    this.aggregatedUsage = Array.from(map.entries())
      .map(([feature, duration]) => ({ feature, duration }))
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10);
  }


  async killAppByName(name: string) {
    if (!this.systemStats) return;
    const targets = this.systemStats.processes.filter(p => p.name.toLowerCase() === name.toLowerCase());
    for (const p of targets) {
      try {
        await invoke('kill_process', { pid: p.pid });
      } catch (e) {
        console.error(`Failed to kill ${p.pid}`, e);
      }
    }
    this.showLimitReachedModal = false;
    this.cdr.markForCheck();
  }


  updateCaches() {
    if (this.activeTab === 'dashboard') {
      this.updateFilteredProcesses();
    } else if (this.activeTab === 'management') {
      this.updateFilteredServices();
      this.updateFilteredStartupApps();
    }
  }

  updateFilteredProcesses() {
    if (!this.systemStats) return;

    let list = this.systemStats.processes.map(p => ({
      ...p,
      isFavorite: this.favorites.has(p.pid)
    }));

    // Search filter
    if (this.searchTerm) {
      const term = this.searchTerm.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(term) || p.pid.toString().includes(term));
    }

    // Sort
    list.sort((a, b) => {
      if (a.isFavorite && !b.isFavorite) return -1;
      if (!a.isFavorite && b.isFavorite) return 1;

      let valA = a[this.sortKey] as any;
      let valB = b[this.sortKey] as any;

      if (typeof valA === 'string') {
        valA = valA.toLowerCase();
        valB = (valB as string).toLowerCase();
      }

      if (valA < valB) return this.sortDir === 'asc' ? -1 : 1;
      if (valA > valB) return this.sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    if (this.showTree && !this.searchTerm) {
      this.p_filteredProcesses = this.buildProcessTree(list);
    } else {
      this.p_filteredProcesses = list.slice(0, 50);
    }
    this.cdr.markForCheck();
  }

  updateFilteredServices() {
    if (!this.managementSearchTerm) {
      this.p_filteredServices = this.services;
    } else {
      const term = this.managementSearchTerm.toLowerCase();
      this.p_filteredServices = this.services.filter(s =>
        s.name.toLowerCase().includes(term) ||
        s.display_name.toLowerCase().includes(term)
      );
    }
  }

  updateFilteredStartupApps() {
    if (!this.managementSearchTerm) {
      this.p_filteredStartupApps = this.startupApps;
    } else {
      const term = this.managementSearchTerm.toLowerCase();
      this.p_filteredStartupApps = this.startupApps.filter(a =>
        a.name.toLowerCase().includes(term) ||
        a.command.toLowerCase().includes(term)
      );
    }
  }

  updateFilteredPorts() {
    const term = this.managementSearchTerm.toLowerCase();
    if (!term) {
      this.p_filteredPorts = [...this.activePorts];
    } else {
      this.p_filteredPorts = this.activePorts.filter(p =>
        p.port.toString().includes(term) ||
        p.process_name.toLowerCase().includes(term) ||
        p.protocol.toLowerCase().includes(term)
      );
    }
    this.cdr.markForCheck();
  }

  updateFilteredDevServers() {
    const term = this.managementSearchTerm.toLowerCase();
    if (!term) {
      this.p_filteredDevServers = [...this.devServers];
    } else {
      this.p_filteredDevServers = this.devServers.filter(s =>
        s.framework.toLowerCase().includes(term) ||
        s.port.toString().includes(term) ||
        s.process_name.toLowerCase().includes(term)
      );
    }
    this.cdr.markForCheck();
  }

  ngAfterViewInit() {
    this.initMainCharts();
  }

  ngOnDestroy() {
    if (this.interval) {
      clearInterval(this.interval);
    }
  }

  async fetchStats() {
    try {
      const stats = await invoke<SystemStats>("get_system_stats");

      const firstLoad = !this.systemStats;

      if (this.lastNetReceived > 0) {
        this.netSpeedIn = stats.net_received - this.lastNetReceived;
        this.netSpeedOut = stats.net_transmitted - this.lastNetTransmitted;
      }
      this.lastNetReceived = stats.net_received;
      this.lastNetTransmitted = stats.net_transmitted;

      this.systemStats = stats;
      this.updateCaches();
      this.checkAlerts(stats);
      // First load: run advisor immediately
      if (firstLoad) this.runAdvisor(stats);
      this.cpuHistory.push(stats.cpu_usage);
      this.cpuHistory.shift();
      const memPct = (stats.memory_used / stats.memory_total) * 100;
      this.memoryHistory.push(memPct);
      this.memoryHistory.shift();

      this.gpuHistory.push(stats.gpu_usage || 0);
      this.gpuHistory.shift();

      this.pingHistory.push(stats.ping || 0);
      this.pingHistory.shift();

      this.netDownHistory.push(this.netSpeedIn);
      this.netDownHistory.shift();
      this.netUpHistory.push(this.netSpeedOut);
      this.netUpHistory.shift();

      this.diskReadHistory.push(stats.disk_read_speed);
      this.diskReadHistory.shift();
      this.diskWriteHistory.push(stats.disk_write_speed);
      this.diskWriteHistory.shift();

      // Track App Usage (Top CPU consumers)
      [...stats.processes]
        .sort((a, b) => b.cpu_usage - a.cpu_usage)
        .slice(0, 10)
        .forEach(p => {
          const current = this.appUsageMap.get(p.name) || 0;
          this.appUsageMap.set(p.name, current + 1);
        });
      this.updateAppUsageList();

      if (this.coreHistories.length === 0) {
        this.coreHistories = stats.cpus.map(() => new Array(this.HISTORY_LIMIT).fill(0));
      }
      stats.cpus.forEach((usage, i) => {
        this.coreHistories[i].push(usage);
        this.coreHistories[i].shift();
      });

      if (firstLoad) {
        setTimeout(() => this.initCoreCharts(), 100);
      }

      this.updateCharts();
      this.updateTopHogs();
    } catch (e) {
      console.error("Failed to fetch system stats", e);
    }
  }

  updateTopHogs() {
    if (!this.systemStats) return;

    // Impact = CPU% + (RAM / Total_RAM * 100)
    const procImpact = (p: ProcessInfo) => {
      const ramPct = (p.memory / (this.systemStats?.memory_total || 1)) * 100;
      return p.cpu_usage + ramPct;
    };

    const list = [...this.systemStats.processes];
    list.sort((a, b) => procImpact(b) - procImpact(a));

    this.topHogs = list.slice(0, 5);
    this.cdr.markForCheck();
  }

  initMainCharts() {
    const commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { display: false },
        y: {
          beginAtZero: true,
          max: 100,
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { color: '#888', font: { size: 10 } }
        }
      },
      plugins: { legend: { display: false } },
      elements: { point: { radius: 0 }, line: { tension: 0.4 } },
      animation: { duration: 0 } as any
    };

    if (this.cpuCanvas) {
      this.cpuChart = new Chart(this.cpuCanvas.nativeElement, {
        type: 'line',
        data: {
          labels: new Array(this.HISTORY_LIMIT).fill(''),
          datasets: [{
            data: this.cpuHistory,
            borderColor: '#4facfe',
            borderWidth: 2,
            fill: true,
            backgroundColor: 'rgba(79, 172, 254, 0.1)',
          }]
        },
        options: commonOptions
      });
    }

    if (this.memoryCanvas) {
      this.memoryChart = new Chart(this.memoryCanvas.nativeElement, {
        type: 'line',
        data: {
          labels: new Array(30).fill(''),
          datasets: [{
            data: this.memoryHistory,
            borderColor: '#00f2fe',
            borderWidth: 2,
            fill: true,
            backgroundColor: 'rgba(0, 242, 254, 0.1)',
          }]
        },
        options: commonOptions
      });
    }

    if (this.gpuCanvas) {
      this.gpuChart = new Chart(this.gpuCanvas.nativeElement, {
        type: 'line',
        data: {
          labels: new Array(30).fill(''),
          datasets: [{
            data: this.gpuHistory,
            borderColor: '#ff5e5e',
            borderWidth: 2,
            fill: true,
            backgroundColor: 'rgba(255, 94, 94, 0.1)',
          }]
        },
        options: commonOptions
      });
    }

    if (this.pingCanvas) {
      this.pingChart = new Chart(this.pingCanvas.nativeElement, {
        type: 'line',
        data: {
          labels: new Array(this.HISTORY_LIMIT).fill(''),
          datasets: [{
            data: this.pingHistory,
            borderColor: '#39ff14',
            borderWidth: 2,
            fill: true,
            backgroundColor: 'rgba(57, 255, 20, 0.1)',
          }]
        },
        options: {
          ...commonOptions,
          scales: { ...commonOptions.scales, y: { ...commonOptions.scales.y, max: undefined } }
        }
      });
    }

    if (this.netTrafficCanvas) {
      this.netTrafficChart = new Chart(this.netTrafficCanvas.nativeElement, {
        type: 'line',
        data: {
          labels: new Array(this.HISTORY_LIMIT).fill(''),
          datasets: [
            {
              label: 'Down',
              data: this.netDownHistory,
              borderColor: '#00f2fe',
              borderWidth: 1.5,
              fill: false,
            },
            {
              label: 'Up',
              data: this.netUpHistory,
              borderColor: '#4facfe',
              borderWidth: 1.5,
              fill: false,
            }
          ]
        },
        options: { ...commonOptions, scales: { ...commonOptions.scales, y: { ...commonOptions.scales.y, max: undefined } } }
      });
    }

    if (this.diskIOHistoryCanvas) {
      this.diskIOChart = new Chart(this.diskIOHistoryCanvas.nativeElement, {
        type: 'line',
        data: {
          labels: new Array(this.HISTORY_LIMIT).fill(''),
          datasets: [
            {
              label: 'Read',
              data: this.diskReadHistory,
              borderColor: '#ff5e5e',
              borderWidth: 1.5,
              fill: false,
            },
            {
              label: 'Write',
              data: this.diskWriteHistory,
              borderColor: '#ffcc00',
              borderWidth: 1.5,
              fill: false,
            }
          ]
        },
        options: { ...commonOptions, scales: { ...commonOptions.scales, y: { ...commonOptions.scales.y, max: undefined } } }
      });
    }
  }

  initCoreCharts() {
    const coreOptions = {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { display: false },
        y: { beginAtZero: true, max: 100, display: false }
      },
      plugins: { legend: { display: false } },
      elements: { point: { radius: 0 }, line: { tension: 0.4 } },
      animation: { duration: 0 } as any
    };

    this.coreCanvases.forEach((canvas, i) => {
      this.coreCharts[i] = new Chart(canvas.nativeElement, {
        type: 'line',
        data: {
          labels: new Array(30).fill(''),
          datasets: [{
            data: this.coreHistories[i],
            borderColor: '#4facfe',
            borderWidth: 1.5,
            fill: true,
            backgroundColor: 'rgba(79, 172, 254, 0.05)',
          }]
        },
        options: coreOptions
      });
    });
  }

  updateCharts() {
    if (this.cpuChart) {
      this.cpuChart.data.datasets[0].data = [...this.cpuHistory];
      this.cpuChart.update();
    }
    if (this.memoryChart) {
      this.memoryChart.data.datasets[0].data = [...this.memoryHistory];
      this.memoryChart.update();
    }
    if (this.gpuChart) {
      this.gpuChart.data.datasets[0].data = [...this.gpuHistory];
      this.gpuChart.update();
    }
    if (this.pingChart) {
      this.pingChart.data.datasets[0].data = [...this.pingHistory];
      this.pingChart.update();
    }
    if (this.netTrafficChart) {
      this.netTrafficChart.data.datasets[0].data = [...this.netDownHistory];
      this.netTrafficChart.data.datasets[1].data = [...this.netUpHistory];
      this.netTrafficChart.update();
    }
    if (this.diskIOChart) {
      this.diskIOChart.data.datasets[0].data = [...this.diskReadHistory];
      this.diskIOChart.data.datasets[1].data = [...this.diskWriteHistory];
      this.diskIOChart.update();
    }
    this.coreCharts.forEach((chart, i) => {
      if (chart) {
        chart.data.datasets[0].data = [...this.coreHistories[i]];
        chart.update();
      }
    });
  }

  formatUptime(seconds: number): string {
    const days = Math.floor(seconds / (24 * 3600));
    const hours = Math.floor((seconds % (24 * 3600)) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
  }

  getDiskUsagePercentage(disk: DiskInfo): number {
    return ((disk.total_space - disk.available_space) / disk.total_space) * 100;
  }

  formatTimestamp(timestamp: number): string {
    if (!timestamp) return 'Unknown';
    return new Date(timestamp * 1000).toLocaleString();
  }

  getHealthColor(score: number): string {
    if (score > 80) return '#6CCB5F';
    if (score > 60) return '#FFD700';
    return '#FF5E5E';
  }

  getHealthStatusMessage(score: number): string {
    if (score > 90) return "System is in peak condition.";
    if (score > 80) return "Healthy but under normal load.";
    if (score > 60) return "Warning: Some performance issues detected.";
    return "Action Required: Take a look at your system!";
  }

  getMemoryPercentage(): number {
    if (!this.systemStats) return 0;
    return (this.systemStats.memory_used / this.systemStats.memory_total) * 100;
  }

  formatBytes(bytes: number): string {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  private async robustDownload(content: string | Blob, fileName: string, type: string) {
    try {
      console.log(`Starting native export via Rust: ${fileName}`);

      let base64Data: string;

      if (content instanceof Blob) {
        // Convert Blob to Base64 for Rust transfer
        const arrayBuffer = await content.arrayBuffer();
        const bytes = new Uint8Array(arrayBuffer);
        let binary = '';
        const len = bytes.byteLength;
        for (let i = 0; i < len; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        base64Data = btoa(binary);
      } else {
        // String content (CSV/JSON/Text)
        base64Data = btoa(unescape(encodeURIComponent(content)));
      }

      const savedPath = await invoke<string>('save_export', {
        filename: fileName,
        base64Content: base64Data
      });

      console.log(`File saved natively at: ${savedPath}`);
      return true;
    } catch (e) {
      console.error("Native export failed", e);
      // Fallback alert with details if Rust bridge fails
      alert("Native Export Error: " + e);
      return false;
    }
  }

  // --- Process Management Methods ---

  toggleFavorite(pid: number) {
    if (this.favorites.has(pid)) this.favorites.delete(pid);
    else this.favorites.add(pid);
    this.updateFilteredProcesses();
  }

  async killProcess(pid: number) {
    if (confirm(`Kill process ${pid}?`)) {
      try {
        await invoke('kill_process', { pid });
        this.fetchStats();
      } catch (e) {
        alert("Failed to kill process: " + e);
      }
    }
  }

  setSort(key: ProcessSortKey) {
    if (this.sortKey === key) {
      this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortKey = key;
      this.sortDir = 'desc';
    }
    this.updateFilteredProcesses();
  }

  onSearch(event: any) {
    this.searchTerm = event.target.value;
    this.updateFilteredProcesses();
  }

  toggleTree() {
    this.showTree = !this.showTree;
    this.updateFilteredProcesses();
  }

  toggleExpand(pid: number) {
    if (this.expandedParents.has(pid)) this.expandedParents.delete(pid);
    else this.expandedParents.add(pid);
  }

  // --- Management Methods ---

  setTab(tab: 'dashboard' | 'performance' | 'processes' | 'management' | 'advisor' | 'reports' | 'dev' | 'gaming' | 'analytics') {
    const now = Date.now();
    const duration = Math.floor((now - this.lastTabChangeTime) / 1000);
    
    // 1. Record usage of previous tab
    if (duration > 0) {
      invoke('save_usage', { 
        userId: this.userId, 
        feature: this.activeTab, 
        duration, 
        timestamp: Math.floor(this.lastTabChangeTime / 1000) 
      }).catch(err => console.error("Failed to record usage", err));
    }

    // 2. Switch tab
    this.activeTab = tab;
    this.lastTabChangeTime = now;
    this.managementSearchTerm = '';

    if (tab === 'management') {
      this.refreshManagementData();
    } else if (tab === 'dev') {
      this.refreshDevData();
    } else if (tab === 'gaming') {
      this.initGamingFeatures();
    } else if (tab === 'performance') {
      setTimeout(() => this.updateCharts(), 50);
    } else if (tab === 'analytics') {
      this.fetchUsageLogs();
      this.fetchDailyUsage();
      this.fetchWeeklyTrends();
      this.fetchUsageLimits();
      setTimeout(() => this.initAnalyticsCharts(), 100);
    }
    this.updateCaches();
    this.cdr.markForCheck();
  }


  setMgmtSubTab(sub: 'services' | 'startup') {
    this.mgmtSubTab = sub;
    this.refreshManagementData();
  }

  // --- Reports & Exports ---

  async exportSystemReport() {
    if (!this.systemStats) return;
    try {
      const doc = new jsPDF();
      const stats = this.systemStats;

      // Header with Fluent Accent
      doc.setFillColor(96, 205, 255);
      doc.rect(0, 0, 210, 40, 'F');

      doc.setTextColor(255, 255, 255);
      doc.setFontSize(24);
      doc.setFont("helvetica", "bold");
      doc.text("System Diagnostic Report", 20, 25);

      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.text(`Generated on: ${new Date().toLocaleString()}`, 20, 34);

      // Section 1: Hardware
      doc.setTextColor(32, 32, 32);
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.text("1. Hardware Specifications", 20, 55);

      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      const hwData = [
        ["Component", "Model / Value"],
        ["CPU", stats.cpu_model],
        ["Architecture", stats.cpu_arch],
        ["Physical Cores", stats.physical_cores.toString()],
        ["Logical Cores", stats.cpu_cores.toString()],
        ["Total Memory", this.formatBytes(stats.memory_total)],
        ["GPU", stats.gpu_name],
        ["OS", `${stats.os_name} ${stats.os_version}`],
        ["System Uptime", this.formatUptime(stats.uptime)]
      ];

      autoTable(doc, {
        startY: 60,
        head: [hwData[0]],
        body: hwData.slice(1),
        theme: 'striped',
        headStyles: { fillColor: [64, 64, 64] }
      });

      // Section 2: Storage
      let finalY = (doc as any).lastAutoTable?.finalY || 150;
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.text("2. Storage Status", 20, finalY + 15);

      const diskData = stats.disks.map(d => [
        d.name,
        d.kind,
        this.formatBytes(d.total_space),
        this.formatBytes(d.available_space),
        `${((1 - d.available_space / d.total_space) * 100).toFixed(1)}%`
      ]);

      autoTable(doc, {
        startY: finalY + 20,
        head: [['Drive', 'Type', 'Total Capacity', 'Available', 'Usage %']],
        body: diskData,
        theme: 'grid'
      });

      // Section 3: Performance Snapshot
      finalY = (doc as any).lastAutoTable?.finalY || finalY + 100;
      doc.setFontSize(16);
      doc.setFont("helvetica", "bold");
      doc.text("3. Current Load Snapshot", 20, finalY + 15);

      autoTable(doc, {
        startY: finalY + 20,
        head: [['Metric', 'Current Value']],
        body: [
          ['Overall CPU Load', `${stats.cpu_usage.toFixed(1)}%`],
          ['Memory Consumption', `${this.formatBytes(stats.memory_used)} (${((stats.memory_used / stats.memory_total) * 100).toFixed(1)}%)`],
          ['Disk Read Speed', `${this.formatBytes(stats.disk_read_speed)}/s`],
          ['Disk Write Speed', `${this.formatBytes(stats.disk_write_speed)}/s`],
          ['Network Download', `${this.formatBytes(this.netSpeedIn)}/s`],
          ['Network Upload', `${this.formatBytes(this.netSpeedOut)}/s`],
          ['Network Latency', `${stats.ping} ms`]
        ],
        theme: 'plain'
      });

      const blob = doc.output('blob');
      await this.robustDownload(blob, `System_Diagnostic_${Date.now()}.pdf`, 'application/pdf');
    } catch (e) {
      alert("Critical error in PDF Generation: " + e);
    }
  }

  async exportPerformanceCSV() {
    if (!this.systemStats) return;
    try {
      const stats = this.systemStats;
      let csv = "Timestamp,OS,CPU_Model,CPU_Usage_Pct,RAM_Used_Bytes,RAM_Total_Bytes,Net_Down_Bps,Net_Up_Bps,Ping_ms,Disk_Read_Bps,Disk_Write_Bps\n";

      for (let i = 0; i < this.HISTORY_LIMIT; i++) {
        const timestamp = new Date(Date.now() - (this.HISTORY_LIMIT - i) * 1000).toISOString();
        const row = [
          timestamp,
          `"${stats.os_name}"`,
          `"${stats.cpu_model}"`,
          (this.cpuHistory[i] || 0).toFixed(2),
          this.memoryHistory[i] ? (this.memoryHistory[i] * stats.memory_total / 100).toFixed(0) : 0,
          stats.memory_total,
          (this.netDownHistory[i] || 0).toFixed(0),
          (this.netUpHistory[i] || 0).toFixed(0),
          (this.pingHistory[i] || 0).toFixed(0),
          (this.diskReadHistory[i] || 0).toFixed(0),
          (this.diskWriteHistory[i] || 0).toFixed(0)
        ].join(",");
        csv += row + "\n";
      }

      await this.robustDownload(csv, `Performance_Telemetry_${Date.now()}.csv`, 'text/csv');
    } catch (e) {
      alert("CSV Export failed: " + e);
    }
  }

  exportHardwareSummary() {
    if (!this.systemStats) return;
    try {
      const stats = this.systemStats;
      const report = {
        report_type: "Hardware & Performance Summary",
        generated_at: new Date().toISOString(),
        system_info: {
          os: stats.os_name,
          os_version: stats.os_version,
          uptime_seconds: stats.uptime,
          boot_time: new Date(Date.now() - stats.uptime * 1000).toISOString()
        },
        processor: {
          model: stats.cpu_model,
          architecture: stats.cpu_arch,
          logical_cores: stats.cpu_cores,
          physical_cores: stats.physical_cores,
          base_frequency_mhz: stats.cpu_freq
        },
        memory: {
          total_bytes: stats.memory_total,
          total_formatted: this.formatBytes(stats.memory_total)
        },
        graphics: {
          renderer: stats.gpu_name,
          vram_total_bytes: stats.vram_total
        },
        storage: stats.disks.map(d => ({
          label: d.name,
          type: d.kind,
          total_capacity: d.total_space,
          available: d.available_space
        })),
        current_snapshot: {
          cpu_load: stats.cpu_usage,
          memory_used: stats.memory_used,
          ping: stats.ping,
          wifi_signal: stats.wifi_signal
        }
      };

      this.robustDownload(JSON.stringify(report, null, 2), `Hardware_Summary_${Date.now()}.json`, 'application/json');
    } catch (e) {
      alert("JSON Export failed: " + e);
    }
  }

  exportUptimeReport() {
    if (!this.systemStats) return;
    try {
      const doc = new jsPDF();
      const stats = this.systemStats;

      doc.setFillColor(0, 120, 212); // Windows Blue
      doc.rect(0, 0, 210, 35, 'F');

      doc.setTextColor(255, 255, 255);
      doc.setFontSize(20);
      doc.text("Reliability & Uptime Report", 20, 22);

      doc.setTextColor(40, 40, 40);
      doc.setFontSize(12);
      doc.text(`Session Analysis for ${stats.os_name}`, 20, 45);

      autoTable(doc, {
        startY: 55,
        head: [['Metric', 'Time / Value']],
        body: [
          ['Last Boot Time', new Date(Date.now() - stats.uptime * 1000).toLocaleString()],
          ['Total System Uptime', this.formatUptime(stats.uptime)],
          ['Monitor Session Start', new Date(this.appStartTime).toLocaleString()],
          ['Monitor Session Duration', this.formatUptime(Math.floor((Date.now() - this.appStartTime) / 1000))],
          ['Current Latency', `${stats.ping} ms`],
          ['Session Health Status', this.advisorScore >= 80 ? 'HEALTHY' : 'NEEDS ATTENTION']
        ],
        theme: 'striped',
        headStyles: { fillColor: [0, 120, 212] }
      });

      const blob = doc.output('blob');
      this.robustDownload(blob, `Uptime_Report_${Date.now()}.pdf`, 'application/pdf');
    } catch (e) {
      alert("PDF Uptime Export failed: " + e);
    }
  }

  async refreshDevData() {
    if (this.isLoadingPorts || this.isLoadingServers || this.isLoadingCoding || this.isLoadingDocker ||
      this.isLoadingDb || this.isLoadingEnv) return;
    try {
      if (this.devSubTab === 'ports') {
        this.isLoadingPorts = true;
        this.activePorts = await invoke<PortInfo[]>('get_active_ports');
        this.updateFilteredPorts();
      } else if (this.devSubTab === 'servers') {
        this.isLoadingServers = true;
        this.devServers = await invoke<DevServerInfo[]>('get_dev_servers');
        this.updateFilteredDevServers();
      } else if (this.devSubTab === 'coding') {
        this.isLoadingCoding = true;
        if (this.systemStats) {
          const keywords = ['node', 'npm', 'yarn', 'python', 'uvicorn', 'deno', 'rust', 'go', 'php'];
          this.codingProcesses = this.systemStats.processes.filter(p =>
            keywords.some(k => p.name.toLowerCase().includes(k))
          );
          this.updateFilteredCodingProcesses();
        }
      } else if (this.devSubTab === 'docker') {
        this.isLoadingDocker = true;
        this.dockerContainers = await invoke<DockerContainer[]>('get_docker_containers');
        this.updateFilteredDockerContainers();
      } else if (this.devSubTab === 'db') {
        this.isLoadingDb = true;
        this.dbServers = await invoke<DbServerInfo[]>('get_db_servers');
        this.updateFilteredDbServers();
      } else if (this.devSubTab === 'env') {
        this.isLoadingEnv = true;
        this.environmentInfo = await invoke<EnvironmentInfo>('get_environment_info');
        this.updateFilteredEnvVars();
      }
      this.lastPortsRefresh = Date.now();
      this.analyzeDevEnvironment();
    } catch (e) {
      console.error("Failed to fetch dev data", e);
    } finally {
      this.isLoadingPorts = false;
      this.isLoadingServers = false;
      this.isLoadingCoding = false;
      this.isLoadingDocker = false;
      this.isLoadingDb = false;
      this.isLoadingEnv = false;
      this.cdr.markForCheck();
    }
  }

  analyzeDevEnvironment() {
    const advices: DevAdvice[] = [];

    // 1. Check for common port conflicts
    const portConflicts = [
      { port: 3000, name: 'React / Next.js' },
      { port: 5173, name: 'Vite' },
      { port: 8080, name: 'Vue / Node' },
      { port: 4200, name: 'Angular' },
      { port: 8000, name: 'Django / PHP' },
      { port: 5000, name: 'Flask / Node' }
    ];

    portConflicts.forEach(conf => {
      const active = this.activePorts.find(p => p.port === conf.port);
      if (active) {
        advices.push({
          id: `port_${conf.port}`,
          severity: 'warning',
          title: `Port ${conf.port} in use`,
          message: `${conf.name} dev server may fail to start. (Occupied by: ${active.process_name})`,
          icon: 'ri-error-warning-line'
        });
      }
    });

    // 2. Check for heavy dev processes
    if (this.systemStats) {
      const heavyProcs = this.systemStats.processes
        .filter(p => (p.name.toLowerCase().includes('node') || p.name.toLowerCase().includes('python')) && p.memory > 1024 * 1024 * 1024);

      heavyProcs.forEach(p => {
        advices.push({
          id: `heavy_proc_${p.pid}`,
          severity: 'info',
          title: 'Resource Intensive Dev Process',
          message: `${p.name} (PID: ${p.pid}) is using ${this.formatBytes(p.memory)} of RAM.`,
          icon: 'ri-ram-line'
        });
      });
    }


    // 4. Docker check
    const stoppedContainers = this.dockerContainers.filter(c => c.state === 'exited').length;
    if (stoppedContainers > 5) {
      advices.push({
        id: 'docker_cleanup',
        severity: 'info',
        title: 'Docker Cleanup Suggestion',
        message: `You have ${stoppedContainers} stopped containers. Pruning them could free up disk space.`,
        icon: 'ri-delete-bin-line'
      });
    }

    this.devAdvices = advices;
    this.cdr.markForCheck();
  }

  updateFilteredDbServers() {
    if (!this.managementSearchTerm) {
      this.p_filteredDbServers = [...this.dbServers];
    } else {
      const term = this.managementSearchTerm.toLowerCase();
      this.p_filteredDbServers = this.dbServers.filter(s =>
        s.name.toLowerCase().includes(term) || s.port.toString().includes(term)
      );
    }
  }


  updateFilteredCodingProcesses() {
    if (!this.managementSearchTerm) {
      this.p_filteredCodingProcesses = [...this.codingProcesses];
    } else {
      const term = this.managementSearchTerm.toLowerCase();
      this.p_filteredCodingProcesses = this.codingProcesses.filter(p =>
        p.name.toLowerCase().includes(term) || p.pid.toString().includes(term)
      );
    }
  }

  updateFilteredDockerContainers() {
    if (!this.managementSearchTerm) {
      this.p_filteredDockerContainers = [...this.dockerContainers];
    } else {
      const term = this.managementSearchTerm.toLowerCase();
      this.p_filteredDockerContainers = this.dockerContainers.filter(c =>
        c.name.toLowerCase().includes(term) || c.image.toLowerCase().includes(term)
      );
    }
  }

  updateFilteredEnvVars() {
    if (!this.environmentInfo) return;
    const term = this.envSearchTerm.toLowerCase();
    const all = Object.entries(this.environmentInfo.env_vars).map(([key, value]) => ({ key, value }));

    if (!term) {
      this.filteredEnvVars = all.sort((a, b) => a.key.localeCompare(b.key));
    } else {
      this.filteredEnvVars = all
        .filter(item => item.key.toLowerCase().includes(term) || item.value.toLowerCase().includes(term))
        .sort((a, b) => a.key.localeCompare(b.key));
    }
  }

  async refreshManagementData() {
    if (this.isLoadingMgmt) return;
    this.isLoadingMgmt = true;
    try {
      if (this.mgmtSubTab === 'services') {
        this.services = []; // Clear current to show loader
        this.services = await invoke<ServiceInfo[]>('get_services');
      } else {
        this.startupApps = []; // Clear current to show loader
        this.startupApps = await invoke<StartupInfo[]>('get_startup_apps');
      }
      this.lastMgmtRefresh = Date.now();
      this.updateFilteredServices();
      this.updateFilteredStartupApps();
    } catch (e) {
      console.error("Failed to fetch management data", e);
    } finally {
      this.isLoadingMgmt = false;
    }
  }

  get filteredServices() {
    return this.p_filteredServices;
  }

  get filteredStartupApps() {
    return this.p_filteredStartupApps;
  }

  get filteredProcesses() {
    return this.p_filteredProcesses;
  }

  // --- Alert System ---

  checkAlerts(stats: SystemStats) {
    const newAlerts: Alert[] = [];

    // 1. CPU Warning
    if (stats.cpu_usage > this.alertThresholds.cpu) {
      newAlerts.push({
        id: 'cpu_high',
        type: 'critical',
        title: 'High CPU Usage',
        message: `CPU is at ${stats.cpu_usage.toFixed(1)}%`,
        timestamp: Date.now()
      });
    }

    // 2. RAM Warning
    const ramPct = (stats.memory_used / stats.memory_total) * 100;
    if (ramPct > this.alertThresholds.ram) {
      newAlerts.push({
        id: 'ram_high',
        type: 'critical',
        title: 'Memory Almost Full',
        message: `RAM usage is at ${ramPct.toFixed(1)}%`,
        timestamp: Date.now()
      });
    }

    // 3. Overheating
    if (stats.cpu_temp && stats.cpu_temp > this.alertThresholds.temp) {
      newAlerts.push({
        id: 'temp_high',
        type: 'critical',
        title: 'Overheating Warning',
        message: `CPU Temperature is dangerous: ${stats.cpu_temp.toFixed(1)}°C`,
        timestamp: Date.now()
      });
    }

    // 4. Disk Space
    stats.disks.forEach(disk => {
      const used = (disk.total_space - disk.available_space) / disk.total_space * 100;
      if (used > this.alertThresholds.disk) {
        newAlerts.push({
          id: `disk_full_${disk.name}`,
          type: 'warning',
          title: 'Disk Almost Full',
          message: `${disk.name} has only ${(disk.available_space / (1024 * 1024 * 1024)).toFixed(1)} GB left`,
          timestamp: Date.now()
        });
      }
    });

    // 5. Internet Connection
    if (stats.ping === null || stats.ping === 0) {
      newAlerts.push({
        id: 'internet_lost',
        type: 'critical',
        title: 'Connection Lost',
        message: 'Unable to reach Google DNS (check network)',
        timestamp: Date.now()
      });
    }

    // Stable update: Keep existing alerts if condition persists, remove if solved
    const activeIds = new Set(newAlerts.map(a => a.id));

    // 1. Remove old alerts that are no longer active
    this.alerts = this.alerts.filter(a => activeIds.has(a.id));

    // 2. Add new alerts ONLY if they are not already in the list
    newAlerts.forEach(newA => {
      if (!this.alerts.some(a => a.id === newA.id)) {
        this.alerts = [newA, ...this.alerts].slice(0, 5);
      }
    });
  }

  dismissAlert(id: string) {
    this.alerts = this.alerts.filter(a => a.id !== id);
  }

  async toggleService(service: ServiceInfo) {
    const action = service.status === 'Running' ? 'stop' : 'start';
    try {
      await invoke('control_service', { name: service.name, action });
      // Powerhell RunAs is async in terms of the window opening, 
      // so we just wait a bit and refresh
      setTimeout(() => this.refreshManagementData(), 1000);
    } catch (e) {
      alert("Failed to control service: " + e);
    }
  }

  onMgmtSearch(event: any) {
    this.managementSearchTerm = event.target.value;
    this.updateFilteredServices();
    this.updateFilteredStartupApps();
    this.updateFilteredPorts();
    this.updateFilteredDevServers();
    this.updateFilteredCodingProcesses();
    this.updateFilteredDockerContainers();
    this.updateFilteredDbServers();
  }

  setDevSubTab(tab: 'ports' | 'servers' | 'coding' | 'docker' | 'db' | 'env') {
    this.devSubTab = tab;
    this.refreshDevData();
  }

  async openProjectFolder(pid: number) {
    try {
      await invoke('open_project_folder', { pid });
    } catch (e) {
      alert(e);
    }
  }


  async controlDocker(id: string, action: string) {
    try {
      this.isLoadingDocker = true;
      this.cdr.markForCheck();
      await invoke('control_docker_container', { id, action });
      // Refresh after a short delay
      setTimeout(() => this.refreshDevData(), 1000);
    } catch (e) {
      alert("Docker Error: " + e);
      this.isLoadingDocker = false;
      this.cdr.markForCheck();
    }
  }

  // --- UI/UX Power Features ---

  toggleTheme() {
    this.isDarkMode = !this.isDarkMode;
    const body = document.documentElement;
    if (this.isDarkMode) {
      body.classList.remove('light-mode');
    } else {
      body.classList.add('light-mode');
    }
  }

  toggleSidebar() {
    this.isSidebarCollapsed = !this.isSidebarCollapsed;
  }

  async toggleAlwaysOnTop() {
    this.isAlwaysOnTop = !this.isAlwaysOnTop;
    await appWindow.setAlwaysOnTop(this.isAlwaysOnTop);
  }

  async toggleMiniMode() {
    this.isMiniMode = !this.isMiniMode;
    if (this.isMiniMode) {
      // Switch to a small transparent overlay size
      await appWindow.setSize(new PhysicalSize(300, 400));
      await appWindow.setResizable(false);
      this.activeTab = 'dashboard';
    } else {
      await appWindow.setSize(new PhysicalSize(1000, 800));
      await appWindow.setResizable(true);
    }
  }


  private buildProcessTree(list: ProcessInfo[]): ProcessInfo[] {
    const tree: ProcessInfo[] = [];
    const map = new Map<number, ProcessInfo[]>();

    list.forEach(p => {
      const parentId = p.parent_pid || 0;
      if (!map.has(parentId)) map.set(parentId, []);
      map.get(parentId)!.push(p);
    });

    const addChildren = (parentId: number, depth: number) => {
      const children = map.get(parentId);
      if (children) {
        children.forEach(child => {
          tree.push({ ...child, name: ' '.repeat(depth * 3) + (depth > 0 ? '┗ ' : '') + child.name });
          if (this.expandedParents.has(child.pid)) {
            addChildren(child.pid, depth + 1);
          }
        });
      }
    };

    addChildren(0, 0); // Start from roots
    return tree.slice(0, 50);
  }

  updateAppUsageList() {
    this.topAppsUsage = Array.from(this.appUsageMap.entries())
      .map(([name, time]) => ({ name, time }))
      .sort((a, b) => b.time - a.time)
      .slice(0, 5);
  }

  formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }

  async minimizeWindow() {
    await appWindow.minimize();
  }

  async toggleMaximize() {
    await appWindow.toggleMaximize();
  }

  async closeWindow() {
    await appWindow.close();
  }

  formatBatteryTime(seconds: number | null | undefined): string {
    if (!seconds) return 'Calculating...';
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  async fetchPublicIp() {
    try {
      const response = await fetch('https://api.ipify.org?format=json');
      const data = await response.json();
      this.publicIp = data.ip;
    } catch (e) {
      this.publicIp = 'Unavailable';
    }
  }

  // ── AI Performance Advisor ─────────────────────────────────────────────

  toggleAdvisor() {
    this.isAdvisorOpen = !this.isAdvisorOpen;
    if (this.isAdvisorOpen && this.systemStats) {
      // Always run the rule-based analysis on open so score is fresh
      this.runAdvisor(this.systemStats);
    }
  }

  setAdvisorMode(mode: 'rule' | 'llm') {
    this.advisorMode = mode;
    if (mode === 'rule' && this.systemStats) {
      this.runAdvisor(this.systemStats);
    }
  }

  async loadLLM() {
    if (this.llmStatus === 'loading' || this.llmStatus === 'ready') return;
    this.llmStatus = 'loading';
    this.llmProgress = 0;
    this.llmProgressText = 'Initialising engine…';
    this.llmError = '';
    try {
      // Dynamically import web-llm only when user requests it
      const webllm: WebLLMModule = await import('@mlc-ai/web-llm');
      const engine = await webllm.CreateMLCEngine(
        this.selectedModel,
        {
          initProgressCallback: (prog: any) => {
            this.llmProgress = Math.round(prog.progress * 100);
            this.llmProgressText = prog.text;
          }
        }
      );
      this.llmEngine = engine;
      this.llmStatus = 'ready';
      this.llmProgressText = 'Model loaded and ready!';
      // Immediately run LLM advice if stats available
      if (this.systemStats) await this.runLLMAdvisor(this.systemStats);
    } catch (err: any) {
      this.llmStatus = 'error';
      this.llmError = err?.message ?? String(err);
    }
  }

  unloadLLM() {
    if (this.llmEngine) {
      this.llmEngine.unload();
      this.llmEngine = null;
    }
    this.llmStatus = 'idle';
    this.llmProgress = 0;
    this.llmProgressText = '';
    this.llmError = '';
    this.llmResponse = '';
  }

  async runLLMAdvisor(stats: SystemStats) {
    if (!this.llmEngine || this.llmStatus !== 'ready') return;
    this.llmStatus = 'thinking';
    this.llmResponse = '';

    const ramPct = ((stats.memory_used / stats.memory_total) * 100).toFixed(1);
    const diskInfo = stats.disks.map(d =>
      `${d.name}: ${((1 - d.available_space / d.total_space) * 100).toFixed(1)}% used`
    ).join(', ');

    const prompt = `You are a system performance advisor. Analyze these real-time metrics and give 3-5 concise, actionable performance tips. Format each tip as a bullet point starting with a severity tag [CRITICAL], [WARNING], [INFO], or [OK].

System Metrics:
- CPU Usage: ${stats.cpu_usage.toFixed(1)}% (${stats.physical_cores} physical cores, ${stats.cpu_model})
- RAM Usage: ${ramPct}% (${this.formatBytes(stats.memory_used)} / ${this.formatBytes(stats.memory_total)})
- GPU Usage: ${stats.gpu_usage.toFixed(1)}% (${stats.gpu_name})
- Disk: ${diskInfo || 'N/A'}
- Network: ↓${this.formatBytes(this.netSpeedIn)}/s  ↑${this.formatBytes(this.netSpeedOut)}/s
- Ping: ${stats.ping}ms
- CPU Temp: ${stats.cpu_temp !== null ? stats.cpu_temp + '°C' : 'N/A'}
- Top processes: ${stats.processes.slice(0, 5).map(p => `${p.name}(${p.cpu_usage.toFixed(1)}%CPU)`).join(', ')}

Provide only the bullet points, no preamble.`;

    try {
      const chunks = await this.llmEngine.chat.completions.create({
        messages: [{ role: 'user', content: prompt }],
        stream: true,
        temperature: 0.3,
        max_tokens: 512,
      });

      let full = '';
      for await (const chunk of chunks) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        full += delta;
        this.llmResponse = full;
      }

      // Parse LLM response into Advice cards
      this.advices = this.parseLLMResponse(full);
      this.llmStatus = 'ready';
    } catch (err: any) {
      this.llmStatus = 'error';
      this.llmError = err?.message ?? String(err);
    }
  }

  parseLLMResponse(text: string): Advice[] {
    const lines = text.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('•') || l.trim().match(/^\[/));
    const advices: Advice[] = [];
    for (const line of lines) {
      const clean = line.replace(/^[-•*]\s*/, '').trim();
      let severity: Advice['severity'] = 'info';
      let icon = 'ri-information-line';
      let body = clean;

      if (/\[CRITICAL\]/i.test(clean)) {
        severity = 'critical'; icon = 'ri-error-warning-fill';
        body = clean.replace(/\[CRITICAL\]/i, '').trim();
      } else if (/\[WARNING\]/i.test(clean)) {
        severity = 'warning'; icon = 'ri-alert-line';
        body = clean.replace(/\[WARNING\]/i, '').trim();
      } else if (/\[OK\]/i.test(clean)) {
        severity = 'good'; icon = 'ri-thumb-up-line';
        body = clean.replace(/\[OK\]/i, '').trim();
      } else if (/\[INFO\]/i.test(clean)) {
        icon = 'ri-information-line';
        body = clean.replace(/\[INFO\]/i, '').trim();
      }

      const colonIdx = body.indexOf(':');
      const title = colonIdx > 0 && colonIdx < 40 ? body.substring(0, colonIdx).trim() : 'AI Insight';
      const message = colonIdx > 0 && colonIdx < 40 ? body.substring(colonIdx + 1).trim() : body;

      advices.push({
        id: 'llm_' + advices.length,
        severity, icon, title, message
      });
    }
    // If nothing parsed, wrap entire response as single info card
    if (advices.length === 0 && text.trim()) {
      advices.push({
        id: 'llm_raw', severity: 'info', icon: 'ri-robot-2-line',
        title: 'AI Analysis', message: text.substring(0, 400)
      });
    }
    return advices;
  }

  runAdvisor(stats: SystemStats) {
    const advices: Advice[] = [];
    const ramPct = (stats.memory_used / stats.memory_total) * 100;
    let penalty = 0;

    // ── CPU ────────────────────────────────────────────────────────────────
    if (stats.cpu_usage > 95) {
      advices.push({
        id: 'cpu_critical', severity: 'critical', icon: 'ri-fire-fill',
        title: 'CPU Maxed Out',
        message: `Your CPU is at ${stats.cpu_usage.toFixed(1)}%. The system is severely bottlenecked.`,
        action: 'Kill high-CPU processes below'
      });
      penalty += 35;
    } else if (stats.cpu_usage > 85) {
      advices.push({
        id: 'cpu_high', severity: 'warning', icon: 'ri-cpu-line',
        title: 'High CPU Usage',
        message: `CPU at ${stats.cpu_usage.toFixed(1)}%. Performance may feel sluggish.`,
        action: 'Check Process Controller for CPU hogs'
      });
      penalty += 20;
    } else if (stats.cpu_usage < 15) {
      advices.push({
        id: 'cpu_idle', severity: 'good', icon: 'ri-check-line',
        title: 'CPU is Healthy',
        message: `CPU usage is only ${stats.cpu_usage.toFixed(1)}%. Plenty of headroom.`
      });
    }

    // ── RAM ────────────────────────────────────────────────────────────────
    if (ramPct > 90) {
      advices.push({
        id: 'ram_critical', severity: 'critical', icon: 'ri-ram-2-line',
        title: 'Memory Almost Full',
        message: `RAM at ${ramPct.toFixed(1)}% — only ${this.formatBytes(stats.memory_total - stats.memory_used)} free. Risk of crashes.`,
        action: 'Close unused applications immediately'
      });
      penalty += 30;
    } else if (ramPct > 80) {
      advices.push({
        id: 'ram_high', severity: 'warning', icon: 'ri-error-warning-fill',
        title: 'High Memory Usage',
        message: `RAM at ${ramPct.toFixed(1)}%. Consider closing browser tabs or background apps.`,
        action: 'Check which apps use the most RAM below'
      });
      penalty += 15;
    }

    // ── Temperature ────────────────────────────────────────────────────────
    if (stats.cpu_temp && stats.cpu_temp > 90) {
      advices.push({
        id: 'temp_danger', severity: 'critical', icon: 'ri-temp-hot-line',
        title: 'CPU Dangerously Hot',
        message: `Temperature is ${stats.cpu_temp.toFixed(0)}°C. Risk of thermal throttling or hardware damage.`,
        action: 'Reduce workload and check cooling'
      });
      penalty += 30;
    } else if (stats.cpu_temp && stats.cpu_temp > 80) {
      advices.push({
        id: 'temp_high', severity: 'warning', icon: 'ri-temp-hot-line',
        title: 'Elevated CPU Temperature',
        message: `CPU is running at ${stats.cpu_temp.toFixed(0)}°C. Consider cleaning fans or reducing tasks.`,
      });
      penalty += 15;
    }

    // ── Disk ────────────────────────────────────────────────────────────────
    stats.disks.forEach(disk => {
      const usedPct = ((disk.total_space - disk.available_space) / disk.total_space) * 100;
      if (disk.total_space === 0) return;
      if (usedPct > 90) {
        advices.push({
          id: `disk_full_${disk.name}`, severity: 'critical', icon: 'ri-hard-drive-2-line',
          title: `Disk ${disk.name} Almost Full`,
          message: `${usedPct.toFixed(1)}% used — only ${this.formatBytes(disk.available_space)} remaining.`,
          action: 'Free up space or move files to another drive'
        });
        penalty += 20;
      } else if (usedPct > 80) {
        advices.push({
          id: `disk_warn_${disk.name}`, severity: 'warning', icon: 'ri-hard-drive-2-line',
          title: `Disk ${disk.name} Getting Full`,
          message: `${usedPct.toFixed(1)}% used. Consider cleaning up temporary files.`
        });
        penalty += 10;
      }
    });

    // ── Network ────────────────────────────────────────────────────────────
    if (stats.ping > 150) {
      advices.push({
        id: 'net_lag', severity: 'warning', icon: 'ri-global-line',
        title: 'High Network Latency',
        message: `Ping is ${stats.ping}ms — web browsing and calls may feel slow.`,
        action: 'Check network or restart router'
      });
      penalty += 10;
    } else if (stats.ping === 0) {
      advices.push({
        id: 'net_down', severity: 'critical', icon: 'ri-wifi-off-line',
        title: 'No Internet Connection',
        message: 'Unable to reach the network. Check your connection.',
      });
      penalty += 20;
    }

    // ── Process-specific hotspots ──────────────────────────────────────────
    const GB = 1024 * 1024 * 1024;
    const MB = 1024 * 1024;

    // Aggregate Chrome memory
    const chromeProcs = stats.processes.filter(p =>
      p.name.toLowerCase().includes('chrome') ||
      p.name.toLowerCase().includes('chromium')
    );
    const chromeRam = chromeProcs.reduce((sum, p) => sum + p.memory, 0);
    if (chromeRam > GB) {
      advices.push({
        id: 'chrome_ram', severity: 'warning', icon: 'ri-global-line',
        title: 'Chrome Using Too Much RAM',
        message: `Chrome is consuming ${this.formatBytes(chromeRam)}. Close unused tabs to free memory.`,
        action: 'Open Chrome → Menu → More Tools → Task Manager'
      });
      penalty += 10;
    } else if (chromeRam > 500 * MB) {
      advices.push({
        id: 'chrome_ram_warn', severity: 'info', icon: 'ri-global-line',
        title: 'Chrome RAM Usage Elevated',
        message: `Chrome is using ${this.formatBytes(chromeRam)}. Closing idle tabs can help.`
      });
    }

    // Single process hogging CPU
    const cpuHog = stats.processes.find(p => p.cpu_usage > 50);
    if (cpuHog) {
      advices.push({
        id: 'proc_cpu_hog', severity: 'warning', icon: 'ri-rocket-line',
        title: 'Process Hogging CPU',
        message: `"${cpuHog.name}" (PID ${cpuHog.pid}) is using ${cpuHog.cpu_usage.toFixed(1)}% CPU.`,
        action: 'Kill it in Process Controller if not needed'
      });
      penalty += 10;
    }

    // Single process hogging RAM (>1.5GB)
    const ramHog = stats.processes
      .filter(p => !p.name.toLowerCase().includes('chrome'))
      .find(p => p.memory > 1.5 * GB);
    if (ramHog) {
      advices.push({
        id: 'proc_ram_hog', severity: 'warning', icon: 'ri-ram-2-line',
        title: 'High-Memory Process Detected',
        message: `"${ramHog.name}" is using ${this.formatBytes(ramHog.memory)} of RAM.`,
        action: 'Consider restarting or closing this app'
      });
      penalty += 8;
    }

    // ── GPU ───────────────────────────────────────────────────────────────
    if (stats.gpu_usage > 95) {
      advices.push({
        id: 'gpu_maxed', severity: 'warning', icon: 'ri-gamepad-line',
        title: 'GPU at Maximum Load',
        message: `GPU usage is ${stats.gpu_usage.toFixed(1)}%. Reduce graphics-intensive tasks if performance drops.`
      });
      penalty += 8;
    }

    // ── All Good ─────────────────────────────────────────────────────────
    if (advices.filter(a => a.severity !== 'good').length === 0) {
      advices.push({
        id: 'all_good', severity: 'good', icon: 'ri-thumb-up-line',
        title: 'System is Running Great',
        message: 'All metrics are within healthy ranges. No action needed.'
      });
    }

    // Sort: critical → warning → info → good
    const order = { critical: 0, warning: 1, info: 2, good: 3 };
    advices.sort((a, b) => order[a.severity] - order[b.severity]);

    this.advices = advices;
    this.advisorScore = Math.max(0, 100 - penalty);
  }

  get criticalAdviceCount(): number {
    return this.advices.filter(a => a.severity === 'critical').length;
  }

  getAdvisorScoreColor(): string {
    if (this.advisorScore >= 80) return '#00ff88';
    if (this.advisorScore >= 60) return '#ffcc00';
    return '#ff4b2b';
  }

  getAdvisorScoreLabel(): string {
    if (this.advisorScore >= 80) return 'Healthy';
    if (this.advisorScore >= 60) return 'Fair';
    if (this.advisorScore >= 40) return 'Poor';
    return 'Critical';
  }

  getSelectedModelLabel(): string {
    const m = this.AVAILABLE_MODELS.find(m => m.id === this.selectedModel);
    return m ? m.label : this.selectedModel;
  }

  // --- TrackBy Functions for Performance ---
  trackByAlert(index: number, item: Alert) { return item.id; }
  trackByAdvice(index: number, item: Advice) { return item.id; }
  trackByPid(index: number, item: { pid: number }) { return item.pid; }
  trackByName(index: number, item: { name: string }) { return item.name; }
  trackByCommand(index: number, item: StartupInfo) { return item.command; }
  trackByIndex(index: number) { return index; }
  trackById(index: number, item: any) { return item.id; }
  trackByKey(index: number, item: any) { return item.key || index; }

  // Gaming Performance Mode Logic
  initGamingFeatures() {
    this.startFpsCounter();
    setTimeout(() => this.initGamingChart(), 100);
  }

  startFpsCounter() {
    let frameCount = 0;
    let lastTime = performance.now();

    const loop = () => {
      if (this.activeTab !== 'gaming') return;
      frameCount++;
      const now = performance.now();
      const delta = now - lastTime;

      if (delta >= 1000) {
        this.fpsValue = Math.round((frameCount * 1000) / delta);
        frameCount = 0;
        lastTime = now;
      }

      // Track frame time (latency)
      const currentFrameTime = performance.now() - now; // This is a rough app-level jitter measure
      this.frameTimeHistory.push(delta); // Use delta as inter-frame delay
      this.frameTimeHistory.shift();

      if (this.gamingChart) {
        this.gamingChart.data.datasets[0].data = [...this.frameTimeHistory];
        this.gamingChart.update('none');
      }

      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  initGamingChart() {
    if (!this.frameTimeCanvas) return;
    if (this.gamingChart) this.gamingChart.destroy();

    this.gamingChart = new Chart(this.frameTimeCanvas.nativeElement, {
      type: 'line',
      data: {
        labels: new Array(60).fill(''),
        datasets: [{
          label: 'Frame Time (ms)',
          data: this.frameTimeHistory,
          borderColor: '#FCE100',
          borderWidth: 2,
          fill: true,
          backgroundColor: 'rgba(252, 225, 0, 0.1)',
          tension: 0.4,
          pointRadius: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { display: false },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(255, 255, 255, 0.05)' },
            ticks: { color: '#888', font: { size: 10 } }
          }
        },
        plugins: { legend: { display: false } },
        animation: { duration: 0 }
      }
    });
  }

  async toggleGamingBoost() {
    this.isBoosting = true;
    try {
      this.isGamingBoostActive = !this.isGamingBoostActive;
      const res = await invoke<string>('toggle_gaming_boost', { active: this.isGamingBoostActive });
      console.log(res);
      if (this.isGamingBoostActive) {
        // Automatically cleanup memory when boosting
        await this.cleanupGamingMemory();
      }
    } catch (e) {
      alert("Failed to toggle boost: " + e);
      this.isGamingBoostActive = !this.isGamingBoostActive;
    } finally {
      this.isBoosting = false;
      this.cdr.markForCheck();
    }
  }

  async cleanupGamingMemory() {
    try {
      const res = await invoke<string>('cleanup_gaming_memory');
      console.log(res);
    } catch (e) {
      console.error(e);
    }
  }

  async toggleOverlay() {
    this.isOverlayActive = !this.isOverlayActive;
    // In a real app, this might open a transparent top-most small window
    // For now, let's use the Mini Mode as our "Hardware Overlay"
    await this.toggleMiniMode();
  }

  // Diagnostics for the user
  async testExportTrigger() {
    alert("Export logic initiated. Please check your Downloads/SystemMonitor_Exports folder.");
    await this.robustDownload("Test content", "test.txt", "text/plain");
  }
  getCoreColor(usage: number): string {
    if (usage > 85) return 'rgba(255, 107, 107, 0.2)';
    if (usage > 60) return 'rgba(252, 225, 0, 0.15)';
    return 'rgba(255, 255, 255, 0.05)';
  }
}


