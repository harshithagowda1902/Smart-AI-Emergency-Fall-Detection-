import { useCallback, useEffect, useRef, useState } from 'react';
import { RedEmergencyNotification } from './components/RedEmergencyNotification';
import { Sidebar } from './components/Sidebar';
import { TopBar } from './components/TopBar';
import {
  INITIAL_ALERTS,
  INITIAL_MEDICAL_HISTORY,
  INITIAL_PATIENT_PROFILE,
  INITIAL_SETTINGS,
} from './data/initialState';
import {
  AlertEvent,
  DatasetLandmarkSample,
  DeviceRole,
  MedicalHistoryEntry,
  MonitoringSettings,
  NavSectionId,
  PatientProfileData,
  ServerEmergencyState,
  SnapshotCapture,
} from './types/caresignal';
import {
  enableCareSignalSound,
  isSoundEnabled,
  playTestAmbulanceSiren,
  setAmbulanceSirenVolume,
  startAmbulanceSiren,
  stopAmbulanceSiren,
} from './utils/audio';
import {
  acknowledgeEmergencyApi,
  clearResolvedHistoryApi,
  EmergencySyncClient,
  fetchServerEmergencyState,
  resolveEmergencyApi,
  stopSirenApi,
  triggerEmergencyApi,
  WsConnectionStatus,
} from './utils/emergencyClient';
import { AlertHistory } from './views/AlertHistory';
import { CaretakerDashboard } from './views/CaretakerDashboard';
import { DatasetCollection } from './views/DatasetCollection';
import { GestureAudioSettings } from './views/GestureAudioSettings';
import { MedicalHistory } from './views/MedicalHistory';
import { ModelTraining } from './views/ModelTraining';
import { PatientMonitoring } from './views/PatientMonitoring';
import { PatientProfile } from './views/PatientProfile';
import { VoiceMessages } from './views/VoiceMessages';

function loadStoredJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function getInitialDeviceRole(): DeviceRole {
  if (typeof window === 'undefined') return 'caretaker';
  const params = new URLSearchParams(window.location.search);
  const urlRole = params.get('role');
  if (urlRole === 'patient' || urlRole === 'caretaker') {
    window.sessionStorage.setItem('caresignal_device_role', urlRole);
    return urlRole;
  }
  const saved = window.sessionStorage.getItem('caresignal_device_role');
  return saved === 'patient' ? 'patient' : 'caretaker';
}

const EMPTY_SERVER_STATE: ServerEmergencyState = {
  activeEmergency: null,
  sirenActive: false,
  history: [],
  connectedClients: [],
  serverUpdatedAt: '',
};

export default function App() {
  const [deviceRole, setDeviceRole] = useState<DeviceRole>(getInitialDeviceRole);
  const [activeSection, setActiveSection] = useState<NavSectionId>(() =>
    getInitialDeviceRole() === 'patient' ? 'monitoring' : 'dashboard'
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState<boolean>(false);
  const [isCameraActive, setIsCameraActive] = useState<boolean>(false);

  const [patientProfile, setPatientProfile] = useState<PatientProfileData>(() =>
    loadStoredJson('caresignal_profile_v1', INITIAL_PATIENT_PROFILE)
  );
  const [medicalHistory, setMedicalHistory] = useState<MedicalHistoryEntry[]>(() =>
    loadStoredJson('caresignal_med_history_v1', INITIAL_MEDICAL_HISTORY)
  );
  const [alerts, setAlerts] = useState<AlertEvent[]>(() =>
    loadStoredJson('caresignal_alerts_v1', INITIAL_ALERTS)
  );
  const [datasetSamples, setDatasetSamples] = useState<DatasetLandmarkSample[]>(() =>
    loadStoredJson('caresignal_dataset_v1', [])
  );
  const [settings, setSettings] = useState<MonitoringSettings>(() => ({
    ...INITIAL_SETTINGS,
    ...loadStoredJson('caresignal_settings_v1', INITIAL_SETTINGS),
  }));
  const [snapshots, setSnapshots] = useState<SnapshotCapture[]>([]);

  // Stage 3 Shared Backend + WebSocket Emergency State
  const [serverState, setServerState] = useState<ServerEmergencyState>(EMPTY_SERVER_STATE);
  const [wsStatus, setWsStatus] = useState<WsConnectionStatus>('connecting');
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => isSoundEnabled());
  const [audioBlockedWarning, setAudioBlockedWarning] = useState<boolean>(false);
  const [isBusyAction, setIsBusyAction] = useState<boolean>(false);
  const syncClientRef = useRef<EmergencySyncClient | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem('caresignal_profile_v1', JSON.stringify(patientProfile));
    } catch {
      // Ignore quota errors
    }
  }, [patientProfile]);

  useEffect(() => {
    try {
      window.localStorage.setItem('caresignal_med_history_v1', JSON.stringify(medicalHistory));
    } catch {
      // Ignore quota errors
    }
  }, [medicalHistory]);

  useEffect(() => {
    try {
      window.localStorage.setItem('caresignal_alerts_v1', JSON.stringify(alerts));
    } catch {
      // Ignore quota errors
    }
  }, [alerts]);

  useEffect(() => {
    try {
      window.localStorage.setItem('caresignal_dataset_v1', JSON.stringify(datasetSamples));
    } catch {
      // Ignore quota errors
    }
  }, [datasetSamples]);

  useEffect(() => {
    try {
      window.localStorage.setItem('caresignal_settings_v1', JSON.stringify(settings));
    } catch {
      // Ignore quota errors
    }
  }, [settings]);

  // Connect WebSocket + load persisted backend state on mount
  useEffect(() => {
    void fetchServerEmergencyState()
      .then((state) => setServerState(state))
      .catch(() => {});

    const label =
      deviceRole === 'patient'
        ? `Patient Monitor (${patientProfile.fullName})`
        : `Caretaker Laptop (${patientProfile.caretakerName})`;

    const client = new EmergencySyncClient({
      role: deviceRole,
      deviceLabel: label,
      onStateUpdate: (nextState) => {
        setServerState(nextState);
      },
      onStatusChange: (status) => {
        setWsStatus(status);
      },
    });
    syncClientRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
      syncClientRef.current = null;
      stopAmbulanceSiren();
    };
    // Run once on mount; role/label updates go through client.updateIdentity below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const label =
      deviceRole === 'patient'
        ? `Patient Monitor (${patientProfile.fullName})`
        : `Caretaker Laptop (${patientProfile.caretakerName})`;
    syncClientRef.current?.updateIdentity(deviceRole, label);
  }, [deviceRole, patientProfile.caretakerName, patientProfile.fullName]);

  // Continuous Ambulance Siren lifecycle strictly enforced on Caretaker Laptop
  useEffect(() => {
    if (deviceRole !== 'caretaker') {
      stopAmbulanceSiren();
      setAudioBlockedWarning(false);
      return;
    }

    if (serverState.sirenActive) {
      const res = startAmbulanceSiren(settings.sirenVolume);
      if (res.blocked) {
        setAudioBlockedWarning(true);
      } else {
        setAudioBlockedWarning(false);
        setSoundEnabled(true);
      }
    } else {
      stopAmbulanceSiren();
      setAudioBlockedWarning(false);
    }
  }, [deviceRole, serverState.sirenActive, soundEnabled, settings.sirenVolume]);

  useEffect(() => {
    setAmbulanceSirenVolume(settings.sirenVolume);
  }, [settings.sirenVolume]);

  const handleChangeDeviceRole = useCallback((nextRole: DeviceRole) => {
    setDeviceRole(nextRole);
    try {
      window.sessionStorage.setItem('caresignal_device_role', nextRole);
    } catch {
      // Ignore storage errors
    }
    if (nextRole === 'patient') {
      setActiveSection('monitoring');
    } else {
      setActiveSection('dashboard');
    }
  }, []);

  const handleEnableSound = useCallback(async () => {
    const res = await enableCareSignalSound();
    if (res === 'enabled') {
      setSoundEnabled(true);
      setAudioBlockedWarning(false);
      if (deviceRole === 'caretaker' && serverState.sirenActive) {
        startAmbulanceSiren(settings.sirenVolume);
      }
    } else {
      setSoundEnabled(false);
      setAudioBlockedWarning(true);
    }
  }, [deviceRole, serverState.sirenActive, settings.sirenVolume]);

  const handleTestSiren = useCallback(async () => {
    const ok = await playTestAmbulanceSiren(settings.sirenVolume);
    if (ok) {
      setSoundEnabled(true);
      setAudioBlockedWarning(false);
    } else {
      setAudioBlockedWarning(true);
    }
  }, [settings.sirenVolume]);

  const handleLogSystemAlert = useCallback(
    (
      severity: AlertEvent['severity'],
      title: string,
      details: string,
      source: AlertEvent['source'] = 'Monitoring Engine'
    ) => {
      const entry: AlertEvent = {
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        timestamp: new Date().toISOString(),
        severity,
        source,
        title,
        details,
        status: severity === 'Emergency' ? 'Unresolved' : 'Acknowledged',
      };
      setAlerts((prev) => [entry, ...prev].slice(0, 60));
    },
    []
  );

  const handleTriggerSharedEmergency = useCallback(
    async (payload: {
      emergencyType: string;
      gestureId?: string;
      source: 'Gesture Recognition' | 'Fall Detection Engine' | 'Caretaker Manual Trigger';
      detectionTimestamp: string;
      reason: string;
    }) => {
      try {
        const clientRequestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const resp = await triggerEmergencyApi({
          ...payload,
          patientId: patientProfile.patientId,
          patientName: patientProfile.fullName,
          clientRequestId,
        });
        setServerState(resp.state);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        handleLogSystemAlert('Warning', 'Backend Emergency Sync Warning', msg, 'Hardware / Model');
      }
    },
    [handleLogSystemAlert, patientProfile.fullName, patientProfile.patientId]
  );

  const handleTriggerManualAlert = useCallback(async () => {
    if (deviceRole === 'caretaker') {
      await handleEnableSound();
    }
    const nowIso = new Date().toISOString();
    handleLogSystemAlert(
      'Emergency',
      'Manual Caretaker Test SOS',
      `Test SOS emergency alert triggered for ${patientProfile.fullName}.`,
      'Caretaker Manual Trigger'
    );
    await handleTriggerSharedEmergency({
      emergencyType: 'Manual SOS Verification Test',
      gestureId: 'manual_test',
      source: 'Caretaker Manual Trigger',
      detectionTimestamp: nowIso,
      reason: `Manual SOS test triggered from ${
        deviceRole === 'caretaker' ? 'Caretaker' : 'Patient'
      } interface to verify flashing alert, continuous siren, and two-laptop sync.`,
    });
  }, [
    deviceRole,
    handleEnableSound,
    handleLogSystemAlert,
    handleTriggerSharedEmergency,
    patientProfile.fullName,
  ]);

  const handleStopSiren = useCallback(
    async (emergencyId?: string) => {
      if (deviceRole !== 'caretaker') return;
      setIsBusyAction(true);
      try {
        stopAmbulanceSiren();
        const res = await stopSirenApi({
          role: 'caretaker',
          emergencyId,
          caretakerIdentity: `${patientProfile.caretakerName} (${patientProfile.caretakerRole})`,
        });
        setServerState(res.state);
        handleLogSystemAlert(
          'System',
          'Siren Stopped by Caretaker',
          `Caretaker ${patientProfile.caretakerName} manually stopped the continuous emergency siren.`,
          'Caretaker Manual Trigger'
        );
      } catch (err) {
        handleLogSystemAlert(
          'Warning',
          'Stop Siren Error',
          err instanceof Error ? err.message : String(err),
          'Hardware / Model'
        );
      } finally {
        setIsBusyAction(false);
      }
    },
    [deviceRole, handleLogSystemAlert, patientProfile.caretakerName, patientProfile.caretakerRole]
  );

  const handleAcknowledgeEmergency = useCallback(
    async (emergencyId?: string) => {
      if (deviceRole !== 'caretaker') return;
      setIsBusyAction(true);
      try {
        const res = await acknowledgeEmergencyApi({
          role: 'caretaker',
          emergencyId,
          caretakerIdentity: `${patientProfile.caretakerName} (${patientProfile.caretakerRole})`,
        });
        setServerState(res.state);
      } catch (err) {
        handleLogSystemAlert(
          'Warning',
          'Acknowledge Error',
          err instanceof Error ? err.message : String(err),
          'Hardware / Model'
        );
      } finally {
        setIsBusyAction(false);
      }
    },
    [deviceRole, handleLogSystemAlert, patientProfile.caretakerName, patientProfile.caretakerRole]
  );

  const handleResolveEmergency = useCallback(
    async (emergencyId?: string) => {
      if (deviceRole !== 'caretaker') return;
      setIsBusyAction(true);
      try {
        const res = await resolveEmergencyApi({
          role: 'caretaker',
          emergencyId,
          caretakerIdentity: `${patientProfile.caretakerName} (${patientProfile.caretakerRole})`,
        });
        setServerState(res.state);
      } catch (err) {
        handleLogSystemAlert(
          'Warning',
          'Resolve Emergency Notice',
          err instanceof Error ? err.message : String(err),
          'Hardware / Model'
        );
      } finally {
        setIsBusyAction(false);
      }
    },
    [deviceRole, handleLogSystemAlert, patientProfile.caretakerName, patientProfile.caretakerRole]
  );

  const handleClearResolvedEmergencies = useCallback(async () => {
    if (deviceRole !== 'caretaker') return;
    setIsBusyAction(true);
    try {
      const res = await clearResolvedHistoryApi('caretaker');
      setServerState(res.state);
    } finally {
      setIsBusyAction(false);
    }
  }, [deviceRole]);

  const handleSnapshotSaved = useCallback((snapshot: SnapshotCapture) => {
    setSnapshots((prev) => [snapshot, ...prev].slice(0, 20));
  }, []);

  const handleDatasetSampleSaved = useCallback((sample: DatasetLandmarkSample) => {
    setDatasetSamples((prev) => [sample, ...prev].slice(0, 250));
  }, []);

  const unresolvedEmergencyCount = serverState.history.filter(
    (h) => h.status !== 'RESOLVED'
  ).length;

  return (
    <div className="min-h-screen flex bg-[#F6FAF7] text-[#11221A]">
      <Sidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        mobileOpen={mobileMenuOpen}
        onCloseMobile={() => setMobileMenuOpen(false)}
        patient={patientProfile}
        isCameraActive={isCameraActive}
      />

      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar
          activeSection={activeSection}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
          onNavigate={setActiveSection}
          onTriggerTestAlert={() => void handleTriggerManualAlert()}
          patient={patientProfile}
          unresolvedAlertCount={unresolvedEmergencyCount}
          deviceRole={deviceRole}
          onChangeDeviceRole={handleChangeDeviceRole}
          wsStatus={wsStatus}
          connectedClients={serverState.connectedClients}
          soundEnabled={soundEnabled}
          onEnableSound={() => void handleEnableSound()}
        />

        {/* Shared Flashing Red Emergency Notification across both Patient & Caretaker Interfaces */}
        <RedEmergencyNotification
          activeEmergency={serverState.activeEmergency}
          sirenActive={serverState.sirenActive}
          deviceRole={deviceRole}
          audioBlockedWarning={audioBlockedWarning}
          soundEnabled={soundEnabled}
          isBusyAction={isBusyAction}
          onEnableSound={() => void handleEnableSound()}
          onStopSiren={() => void handleStopSiren(serverState.activeEmergency?.id)}
          onAcknowledge={() => void handleAcknowledgeEmergency(serverState.activeEmergency?.id)}
          onResolve={() => void handleResolveEmergency(serverState.activeEmergency?.id)}
        />

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-[1440px] w-full mx-auto">
          {activeSection === 'dashboard' && (
            <CaretakerDashboard
              patient={patientProfile}
              isCameraActive={isCameraActive}
              alerts={alerts}
              snapshots={snapshots}
              datasetSamples={datasetSamples}
              medicalHistory={medicalHistory}
              onNavigate={setActiveSection}
              deviceRole={deviceRole}
              serverState={serverState}
              wsStatus={wsStatus}
              soundEnabled={soundEnabled}
              audioBlockedWarning={audioBlockedWarning}
              sirenVolume={settings.sirenVolume}
              isBusyAction={isBusyAction}
              onEnableSound={() => void handleEnableSound()}
              onTestSiren={() => void handleTestSiren()}
              onSirenVolumeChange={(vol) => setSettings((prev) => ({ ...prev, sirenVolume: vol }))}
              onStopSiren={() => void handleStopSiren(serverState.activeEmergency?.id)}
              onAcknowledgeEmergency={(id) => void handleAcknowledgeEmergency(id)}
              onResolveEmergency={(id) => void handleResolveEmergency(id)}
              onTriggerManualEmergency={() => void handleTriggerManualAlert()}
            />
          )}

          {activeSection === 'monitoring' && (
            <PatientMonitoring
              settings={settings}
              deviceRole={deviceRole}
              activeEmergency={serverState.activeEmergency}
              sirenActive={serverState.sirenActive}
              wsStatus={wsStatus}
              onCameraStateChange={setIsCameraActive}
              onSnapshotSaved={handleSnapshotSaved}
              onDatasetSampleSaved={handleDatasetSampleSaved}
              onLogSystemAlert={handleLogSystemAlert}
              onTriggerSharedEmergency={(payload) => void handleTriggerSharedEmergency(payload)}
              snapshots={snapshots}
            />
          )}

          {activeSection === 'profile' && (
            <PatientProfile
              profile={patientProfile}
              onSaveProfile={setPatientProfile}
              onResetProfile={() => setPatientProfile(INITIAL_PATIENT_PROFILE)}
            />
          )}

          {activeSection === 'medical-history' && (
            <MedicalHistory
              entries={medicalHistory}
              onAddEntry={(entry) => setMedicalHistory((prev) => [entry, ...prev])}
              onDeleteEntry={(id) =>
                setMedicalHistory((prev) => prev.filter((item) => item.id !== id))
              }
            />
          )}

          {activeSection === 'dataset' && (
            <DatasetCollection
              samples={datasetSamples}
              onDeleteSample={(id) =>
                setDatasetSamples((prev) => prev.filter((s) => s.id !== id))
              }
              onUpdateSplit={(id, split) =>
                setDatasetSamples((prev) =>
                  prev.map((s) => (s.id === id ? { ...s, split } : s))
                )
              }
              onClearSamples={() => setDatasetSamples([])}
              onNavigate={setActiveSection}
            />
          )}

          {activeSection === 'model-training' && (
            <ModelTraining samples={datasetSamples} onNavigate={setActiveSection} />
          )}

          {activeSection === 'alerts' && (
            <AlertHistory
              alerts={alerts}
              emergencyHistory={serverState.history}
              deviceRole={deviceRole}
              isBusyAction={isBusyAction}
              onTriggerManualEmergency={() => void handleTriggerManualAlert()}
              onUpdateStatus={(id, status) =>
                setAlerts((prev) =>
                  prev.map((a) => (a.id === id ? { ...a, status } : a))
                )
              }
              onClearResolved={() =>
                setAlerts((prev) => prev.filter((a) => a.status !== 'Resolved'))
              }
              onAcknowledgeEmergency={(id) => void handleAcknowledgeEmergency(id)}
              onStopSiren={(id) => void handleStopSiren(id)}
              onResolveEmergency={(id) => void handleResolveEmergency(id)}
              onClearResolvedEmergencies={() => void handleClearResolvedEmergencies()}
            />
          )}

          {activeSection === 'voice-messages' && <VoiceMessages />}

          {activeSection === 'settings' && (
            <GestureAudioSettings
              settings={settings}
              soundEnabled={soundEnabled}
              onEnableSound={() => void handleEnableSound()}
              onTestSiren={() => void handleTestSiren()}
              onSaveSettings={setSettings}
              onResetSettings={() => setSettings(INITIAL_SETTINGS)}
            />
          )}
        </main>
      </div>
    </div>
  );
}

