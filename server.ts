import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';

type DeviceRole = 'caretaker' | 'patient';

type EmergencyStatusCode =
  | 'ACTIVE_EMERGENCY'
  | 'ACKNOWLEDGED_SIREN_ACTIVE'
  | 'SIREN_STOPPED_BY_CARETAKER'
  | 'RESOLVED';

interface EmergencyRecord {
  id: string;
  clientRequestId?: string;
  emergencyType: string;
  gestureId?: string;
  source: 'Gesture Recognition' | 'Fall Detection Engine' | 'Caretaker Manual Trigger';
  patientId: string;
  patientName: string;
  detectionTimestamp: string;
  alertDeliveryTime: string;
  acknowledgementTime: string | null;
  acknowledgedBy: string | null;
  sirenStartTime: string | null;
  sirenStopTime: string | null;
  sirenStoppedBy: string | null;
  sirenActive: boolean;
  status: EmergencyStatusCode;
  reason: string;
}

interface ConnectedClientMeta {
  clientId: string;
  role: DeviceRole;
  deviceLabel: string;
  connectedAt: string;
}

interface PersistedEmergencyStore {
  activeEmergencyId: string | null;
  sirenActive: boolean;
  history: EmergencyRecord[];
  serverUpdatedAt: string;
}

const PORT = 3000;
const DATA_DIR = path.resolve(process.cwd(), 'data');
const STATE_FILE = path.join(DATA_DIR, 'emergency-state.json');

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadPersistedStore(): PersistedEmergencyStore {
  ensureDataDir();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<PersistedEmergencyStore>;
      if (Array.isArray(parsed.history)) {
        return {
          activeEmergencyId:
            typeof parsed.activeEmergencyId === 'string' ? parsed.activeEmergencyId : null,
          sirenActive: Boolean(parsed.sirenActive),
          history: parsed.history.slice(0, 150),
          serverUpdatedAt:
            typeof parsed.serverUpdatedAt === 'string'
              ? parsed.serverUpdatedAt
              : new Date().toISOString(),
        };
      }
    }
  } catch (err) {
    console.warn('Could not read persisted emergency state, initializing fresh store:', err);
  }
  return {
    activeEmergencyId: null,
    sirenActive: false,
    history: [],
    serverUpdatedAt: new Date().toISOString(),
  };
}

let store: PersistedEmergencyStore = loadPersistedStore();

function savePersistedStore(): void {
  ensureDataDir();
  store.serverUpdatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to persist emergency state:', err);
  }
}

const clientMetaMap = new Map<WebSocket, ConnectedClientMeta>();

function getPublicState() {
  const activeEmergency = store.activeEmergencyId
    ? store.history.find((item) => item.id === store.activeEmergencyId) ?? null
    : null;

  return {
    activeEmergency,
    sirenActive: store.sirenActive,
    history: store.history,
    connectedClients: Array.from(clientMetaMap.values()),
    serverUpdatedAt: store.serverUpdatedAt,
  };
}

function sanitizeString(input: unknown, maxLen = 200): string {
  if (typeof input !== 'string') return '';
  return input.trim().slice(0, maxLen);
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '256kb' }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const broadcastState = (eventType = 'state:sync') => {
    const payload = JSON.stringify({
      type: eventType,
      payload: getPublicState(),
    });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  };

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url ?? '/ws', `http://${req.headers.host ?? 'localhost'}`);
    const rawRole = url.searchParams.get('role');
    const role: DeviceRole = rawRole === 'patient' ? 'patient' : 'caretaker';
    const deviceLabel =
      sanitizeString(url.searchParams.get('label'), 60) ||
      (role === 'patient' ? 'Patient Laptop' : 'Caretaker Laptop');

    const meta: ConnectedClientMeta = {
      clientId: `cli-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      role,
      deviceLabel,
      connectedAt: new Date().toISOString(),
    };
    clientMetaMap.set(ws, meta);

    // Send authoritative initial state immediately
    ws.send(JSON.stringify({ type: 'state:sync', payload: getPublicState() }));
    broadcastState('presence:updated');

    ws.on('message', (rawMsg) => {
      try {
        const msg = JSON.parse(rawMsg.toString()) as {
          type?: string;
          role?: DeviceRole;
          deviceLabel?: string;
        };
        if (msg.type === 'client:identify') {
          const nextRole: DeviceRole = msg.role === 'patient' ? 'patient' : 'caretaker';
          const nextLabel =
            sanitizeString(msg.deviceLabel, 60) ||
            (nextRole === 'patient' ? 'Patient Laptop' : 'Caretaker Laptop');
          meta.role = nextRole;
          meta.deviceLabel = nextLabel;
          broadcastState('presence:updated');
        } else if (msg.type === 'state:request') {
          ws.send(JSON.stringify({ type: 'state:sync', payload: getPublicState() }));
        }
      } catch {
        // Ignore malformed WS packets
      }
    });

    ws.on('close', () => {
      clientMetaMap.delete(ws);
      broadcastState('presence:updated');
    });
  });

  // Health & State Endpoints
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, clients: clientMetaMap.size, sirenActive: store.sirenActive });
  });

  app.get('/api/state', (_req, res) => {
    res.json(getPublicState());
  });

  // Trigger Emergency (Patient laptop, or Caretaker manual test)
  app.post('/api/emergency/trigger', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const emergencyType = sanitizeString(body.emergencyType, 120);
    const gestureId = sanitizeString(body.gestureId, 60) || undefined;
    const rawSource = sanitizeString(body.source, 60);
    const source: EmergencyRecord['source'] =
      rawSource === 'Fall Detection Engine'
        ? 'Fall Detection Engine'
        : rawSource === 'Caretaker Manual Trigger'
          ? 'Caretaker Manual Trigger'
          : 'Gesture Recognition';
    const patientId = sanitizeString(body.patientId, 60) || 'CS-PT-1042';
    const patientName = sanitizeString(body.patientName, 100) || 'Patient';
    const detectionTimestamp =
      sanitizeString(body.detectionTimestamp, 64) || new Date().toISOString();
    const reason =
      sanitizeString(body.reason, 400) || `${emergencyType} confirmed by live monitoring.`;
    const clientRequestId = sanitizeString(body.clientRequestId, 80) || undefined;

    if (!emergencyType) {
      res.status(400).json({ error: 'emergencyType is required.' });
      return;
    }

    // 1. Idempotency check by clientRequestId
    if (clientRequestId) {
      const existing = store.history.find((h) => h.clientRequestId === clientRequestId);
      if (existing) {
        res.json({ created: false, idempotent: true, record: existing, state: getPublicState() });
        return;
      }
    }

    // 2. Duplicate prevention for the same active or recently triggered emergency type
    const active = store.activeEmergencyId
      ? store.history.find((h) => h.id === store.activeEmergencyId) ?? null
      : null;

    if (
      active &&
      active.status !== 'RESOLVED' &&
      active.emergencyType === emergencyType &&
      (active.sirenActive ||
        Date.now() - new Date(active.alertDeliveryTime).getTime() < 12000)
    ) {
      res.json({
        created: false,
        duplicatePrevented: true,
        record: active,
        state: getPublicState(),
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const newRecord: EmergencyRecord = {
      id: `emg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      clientRequestId,
      emergencyType,
      gestureId,
      source,
      patientId,
      patientName,
      detectionTimestamp,
      alertDeliveryTime: nowIso,
      acknowledgementTime: null,
      acknowledgedBy: null,
      sirenStartTime: nowIso,
      sirenStopTime: null,
      sirenStoppedBy: null,
      sirenActive: true,
      status: 'ACTIVE_EMERGENCY',
      reason,
    };

    store.history = [newRecord, ...store.history].slice(0, 150);
    store.activeEmergencyId = newRecord.id;
    store.sirenActive = true;
    savePersistedStore();

    broadcastState('emergency:created');
    res.status(201).json({ created: true, record: newRecord, state: getPublicState() });
  });

  // Caretaker-only: Acknowledge Emergency (DOES NOT stop the siren)
  app.post('/api/emergency/acknowledge', (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (body.role !== 'caretaker') {
      res
        .status(403)
        .json({ error: 'Only the caretaker interface can acknowledge an emergency.' });
      return;
    }

    const emergencyId = sanitizeString(body.emergencyId, 80) || store.activeEmergencyId;
    const caretakerIdentity =
      sanitizeString(body.caretakerIdentity, 100) || 'Caretaker Session';

    const target = store.history.find((h) => h.id === emergencyId);
    if (!target) {
      res.status(404).json({ error: 'Emergency record not found.' });
      return;
    }

    if (!target.acknowledgementTime) {
      target.acknowledgementTime = new Date().toISOString();
      target.acknowledgedBy = caretakerIdentity;
    }
    if (target.sirenActive) {
      target.status = 'ACKNOWLEDGED_SIREN_ACTIVE';
    }

    savePersistedStore();
    broadcastState('emergency:acknowledged');
    res.json({ record: target, state: getPublicState() });
  });

  // Caretaker-only: STOP SIREN (Explicit manual action; patient cannot call)
  app.post('/api/emergency/stop-siren', (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (body.role !== 'caretaker') {
      res.status(403).json({
        error: 'Forbidden: Only the caretaker dashboard can stop the emergency siren.',
      });
      return;
    }

    const emergencyId = sanitizeString(body.emergencyId, 80) || store.activeEmergencyId;
    const caretakerIdentity =
      sanitizeString(body.caretakerIdentity, 100) || 'Caretaker Session';
    const nowIso = new Date().toISOString();

    store.sirenActive = false;

    // Stop active siren flags on any active records
    let updatedTarget: EmergencyRecord | null = null;
    for (const rec of store.history) {
      if (rec.id === emergencyId || rec.sirenActive) {
        rec.sirenActive = false;
        rec.sirenStopTime = rec.sirenStopTime ?? nowIso;
        rec.sirenStoppedBy = rec.sirenStoppedBy ?? caretakerIdentity;
        if (rec.status !== 'RESOLVED') {
          rec.status = 'SIREN_STOPPED_BY_CARETAKER';
        }
        if (rec.id === emergencyId) {
          updatedTarget = rec;
        }
      }
    }

    savePersistedStore();
    broadcastState('siren:stopped');
    res.json({ record: updatedTarget, state: getPublicState() });
  });

  // Caretaker-only: Resolve Emergency
  app.post('/api/emergency/resolve', (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (body.role !== 'caretaker') {
      res.status(403).json({ error: 'Only the caretaker can resolve emergencies.' });
      return;
    }

    const emergencyId = sanitizeString(body.emergencyId, 80) || store.activeEmergencyId;
    const caretakerIdentity =
      sanitizeString(body.caretakerIdentity, 100) || 'Caretaker Session';
    const target = store.history.find((h) => h.id === emergencyId);
    if (!target) {
      res.status(404).json({ error: 'Emergency record not found.' });
      return;
    }

    if (target.sirenActive || store.sirenActive) {
      res.status(409).json({
        error: 'Stop the active siren before marking the emergency resolved.',
      });
      return;
    }

    const nowIso = new Date().toISOString();
    target.acknowledgementTime = target.acknowledgementTime ?? nowIso;
    target.acknowledgedBy = target.acknowledgedBy ?? caretakerIdentity;
    target.status = 'RESOLVED';

    if (store.activeEmergencyId === target.id) {
      store.activeEmergencyId = null;
    }

    savePersistedStore();
    broadcastState('emergency:resolved');
    res.json({ record: target, state: getPublicState() });
  });

  // Caretaker-only: Clear resolved records from history
  app.post('/api/emergency/clear-resolved', (req, res) => {
    const body = req.body as Record<string, unknown>;
    if (body.role !== 'caretaker') {
      res.status(403).json({ error: 'Only the caretaker can clear resolved history.' });
      return;
    }

    store.history = store.history.filter(
      (h) => h.status !== 'RESOLVED' || h.id === store.activeEmergencyId
    );
    savePersistedStore();
    broadcastState('history:cleared');
    res.json({ state: getPublicState() });
  });

  // Vite dev middleware or static production build
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`CARESIGNAL server listening on http://0.0.0.0:${PORT}`);
  });
}

void startServer();
