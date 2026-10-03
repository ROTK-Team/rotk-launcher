using System.Diagnostics;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using NAudio.Wave;
using NAudio.CoreAudioApi;

namespace RotkDeathcomm;

internal sealed record Configuration(int GamePid, string GameRoot, string Server, string Token);
internal static class Program
{
    public static async Task<int> Main()
    {
        try
        {
            // The bearer travels over the launcher's anonymous stdin pipe, never command-line or disk.
            string? line = await Console.In.ReadLineAsync();
            if (line == null || line.Length > 8192) return 2;
            var options = JsonSerializer.Deserialize<Configuration>(line);
            if (options == null || options.GamePid <= 0 || options.Token.Length is < 1 or > 512) return 2;
            var endpoint = new Uri(options.Server);
            if (endpoint.Scheme != "wss" && !(endpoint.Scheme == "ws" && endpoint.IsLoopback)) return 2;
            if (endpoint.AbsolutePath != "/voice/v1/deathcomm" || endpoint.UserInfo.Length > 0 || endpoint.Query.Length > 0) return 2;
            using var game = Process.GetProcessById(options.GamePid);
            using var lifetime = new CancellationTokenSource();
            var monitor = Task.Run(async () => {
                try { await game.WaitForExitAsync(lifetime.Token); } catch (OperationCanceledException) { }
                finally { lifetime.Cancel(); }
            });
            using var indicator = new CaptureIndicator(options.GamePid);
            try
            {
                int backoff = 1000;
                while (!lifetime.IsCancellationRequested)
                {
                    using var socket = new ClientWebSocket();
                    socket.Options.SetRequestHeader("Authorization", "Bearer " + options.Token);
                    socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(10);
                    using var connect = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                    connect.CancelAfter(5000);
                    try
                    {
                        await socket.ConnectAsync(endpoint, connect.Token);
                        backoff = 1000;
                        using var session = new DeathcommSession(socket, options, indicator);
                        await session.Run(lifetime.Token);
                    }
                    catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException)
                    { /* Optional voice: reconnect without exposing credentials or interrupting the game. */ }
                    if (!lifetime.IsCancellationRequested) await Task.Delay(backoff, lifetime.Token);
                    backoff = Math.Min(15000, backoff * 2);
                }
            }
            catch (OperationCanceledException) { }
            finally { lifetime.Cancel(); await monitor; }
            return 0;
        }
        catch { return 1; }
    }
}

internal sealed class DeathcommSession : IDisposable
{
    private readonly WebSocket socket;
    private readonly Configuration options;
    private readonly ICaptureIndicator indicator;
    private readonly Func<bool>? microphonePermission;
    private readonly Func<long, IPlayback> createPlayback;
    private readonly Func<ICapture> createCapture;
    private readonly object gate = new();
    private readonly object controlGate = new();
    private readonly Channel<byte[]> outgoing = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(5) {
        FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true, SingleWriter = false });
    private readonly Dictionary<string, IPlayback> listeners = new();
    private ICapture? capture;
    private string? captureId;
    private long captureUntil;
    private bool captureAllowed;
    private byte[]? capturePrefix;
    private readonly byte[] frame = new byte[640];
    private int frameOffset;
    private bool disposed;
    public DeathcommSession(WebSocket socket, Configuration options, ICaptureIndicator indicator,
        Func<bool>? microphonePermission = null, Func<long, IPlayback>? createPlayback = null, Func<ICapture>? createCapture = null)
    {
        this.socket = socket; this.options = options; this.indicator = indicator;
        this.microphonePermission = microphonePermission; this.createPlayback = createPlayback ?? (until => new Playback(until));
        this.createCapture = createCapture ?? (() => new MicrophoneCapture(
            MicrophonePolicy.InputDevice(File.ReadAllText(Path.Combine(options.GameRoot, "UserOptions.ini")))));
    }

    public async Task Run(CancellationToken outer)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(outer);
        Task send = Send(lifetime.Token), receive = Receive(lifetime.Token), tick = Tick(lifetime.Token);
        try { await await Task.WhenAny(send, receive, tick); }
        finally
        {
            lifetime.Cancel(); socket.Abort(); StopCapture();
            try { await Task.WhenAll(send, receive, tick); } catch (Exception e) when (e is OperationCanceledException or WebSocketException) { }
        }
    }
    private bool MicrophoneAllowed()
    {
        if (microphonePermission != null) return microphonePermission();
        try
        {
            GetWindowThreadProcessId(GetForegroundWindow(), out uint foreground);
            string settings = File.ReadAllText(Path.Combine(options.GameRoot, "UserOptions.ini"));
            return foreground == options.GamePid && MicrophonePolicy.Allows(settings) &&
                (capture == null || capture.Permitted(settings));
        }
        catch { return false; }
    }
    private async Task Tick(CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            string? stopId;
            lock (gate)
            {
                captureAllowed = captureId != null && MicrophoneAllowed();
                stopId = captureId != null && (!captureAllowed || Environment.TickCount64 >= captureUntil) ? captureId : null;
                foreach (var entry in listeners.ToArray())
                    if (Environment.TickCount64 >= entry.Value.Until) { entry.Value.Dispose(); listeners.Remove(entry.Key); }
            }
            if (stopId != null) StopCapture(stopId);
            await Task.Delay(20, token);
        }
    }
    private async Task Receive(CancellationToken token)
    {
        byte[] buffer = new byte[2048];
        while (!token.IsCancellationRequested)
        {
            var result = await socket.ReceiveAsync(buffer.AsMemory(), token);
            if (result.MessageType == WebSocketMessageType.Close) return;
            int count = result.Count;
            var messageType = result.MessageType;
            while (!result.EndOfMessage)
            {
                if (count == buffer.Length) throw new IOException("Oversized deathcomm frame");
                result = await socket.ReceiveAsync(buffer.AsMemory(count), token);
                if (result.MessageType == WebSocketMessageType.Close) return;
                if (result.MessageType != messageType) throw new IOException("Invalid fragmented deathcomm frame");
                count += result.Count;
            }
            if (result.MessageType == WebSocketMessageType.Binary)
            {
                if (count != 656) continue;
                string id = Convert.ToHexString(buffer.AsSpan(0, 16)).ToLowerInvariant();
                lock (gate)
                    if (listeners.TryGetValue(id, out var player) && Environment.TickCount64 < player.Until)
                        player.Append(buffer, 16, 640);
                continue;
            }
            try
            {
                using var doc = JsonDocument.Parse(buffer.AsMemory(0, count));
                var root = doc.RootElement;
                string? type = root.GetProperty("type").GetString(), grantId = root.GetProperty("id").GetString();
                if (grantId == null || grantId.Length != 32 || !grantId.All(Uri.IsHexDigit)) continue;
                if (type == "stop")
                {
                    bool stop; lock (gate) { stop = captureId == grantId; if (listeners.Remove(grantId, out var old)) old.Dispose(); }
                    if (stop) StopCapture();
                    continue;
                }
                if (!root.TryGetProperty("remainingMs", out var duration) || !duration.TryGetInt32(out int ms) || ms <= 0 || ms > 4000) continue;
                long until = Environment.TickCount64 + ms;
                if (type == "capture") StartCapture(grantId, until);
                else if (type == "listen")
                {
                    lock (gate)
                    {
                        if (listeners.ContainsKey(grantId) || listeners.Count >= 4) continue;
                        // A private server-granted reaction is independent of the
                        // killer's native chat switches and receive-volume sliders.
                        // This never opens their microphone or changes preferences.
                        IPlayback? player = null;
                        try { player = createPlayback(until); listeners.Add(grantId, player); }
                        catch { player?.Dispose(); /* No output device. */ }
                    }
                }
            }
            catch (Exception e) when (e is JsonException or KeyNotFoundException or InvalidOperationException)
            { /* Malformed or unexpected text frame: skip it, the session outlives a bad gateway message. */ }
        }
    }
    private void StartCapture(string id, long until)
    {
        lock (controlGate)
        {
            StopCapture();
            if (!MicrophoneAllowed() || Environment.TickCount64 >= until) return;
            try
            {
                var device = createCapture();
                lock (gate)
                {
                    capture = device; captureId = id; capturePrefix = Convert.FromHexString(id); captureUntil = until;
                    captureAllowed = true; frameOffset = 0;
                }
                device.DataAvailable += OnData;
                device.Start(); indicator.ShowUntil(until);
            }
            catch { StopCapture(); }
        }
    }
    private void OnData(object? sender, WaveInEventArgs e)
    {
        lock (gate)
        {
            if (sender != capture || !captureAllowed || captureId == null || Environment.TickCount64 >= captureUntil) return;
            for (int offset = 0; offset < e.BytesRecorded;)
            {
                int length = Math.Min(640 - frameOffset, e.BytesRecorded - offset);
                Array.Copy(e.Buffer, offset, frame, frameOffset, length); offset += length; frameOffset += length;
                if (frameOffset == 640)
                {
                    var packet = new byte[656]; capturePrefix!.CopyTo(packet, 0); frame.CopyTo(packet, 16);
                    outgoing.Writer.TryWrite(packet); frameOffset = 0;
                }
            }
        }
    }
    private async Task Send(CancellationToken token)
    {
        await foreach (var packet in outgoing.Reader.ReadAllAsync(token))
        {
            lock (gate)
            {
                if (!captureAllowed || captureId == null || Environment.TickCount64 >= captureUntil ||
                    !packet.AsSpan(0, 16).SequenceEqual(capturePrefix)) continue;
            }
            await socket.SendAsync(packet.AsMemory(), WebSocketMessageType.Binary, true, token);
        }
    }
    private void StopCapture(string? expectedId = null)
    {
        lock (controlGate)
        {
            ICapture? previous;
            lock (gate)
            {
                if (expectedId != null && captureId != expectedId) return;
                previous = capture; capture = null; captureId = null; capturePrefix = null; captureAllowed = false; frameOffset = 0;
            }
            indicator.ShowUntil(0);
            if (previous != null) { previous.DataAvailable -= OnData; try { previous.Stop(); } finally { previous.Dispose(); } }
        }
    }
    public void Dispose()
    {
        if (disposed) return; disposed = true; StopCapture(); outgoing.Writer.TryComplete();
        lock (gate) { foreach (var player in listeners.Values) player.Dispose(); listeners.Clear(); }
    }
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint hwnd, out uint processId);
}

internal interface IPlayback : IDisposable
{
    long Until { get; }
    void Append(byte[] data, int offset, int length);
}
internal interface ICaptureIndicator { void ShowUntil(long value); }
internal interface ICapture : IDisposable
{
    event EventHandler<WaveInEventArgs> DataAvailable;
    bool Permitted(string settings);
    void Start();
    void Stop();
}
internal sealed class MicrophoneCapture : ICapture
{
    private readonly WaveInEvent input;
    private readonly MMDevice endpoint;
    private readonly string selectedName;
    public event EventHandler<WaveInEventArgs>? DataAvailable;
    public MicrophoneCapture(string? name)
    {
        selectedName = name ?? throw new IOException("Ambiguous input preference");
        using var devices = new MMDeviceEnumerator();
        if (name == "Default System Device") endpoint = devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Console);
        else if (name == "Default Communication Device" || name == "Default Communications Device")
            endpoint = devices.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
        else
        {
            var matches = devices.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active).Where(d => d.FriendlyName == name || d.ID == name).ToArray();
            if (matches.Length != 1) { foreach (var d in matches) d.Dispose(); throw new IOException("Selected microphone unavailable or ambiguous"); }
            endpoint = matches[0];
        }
        try
        {
            var indices = Enumerable.Range(0, WaveIn.DeviceCount).Where(i => {
                string product = WaveIn.GetCapabilities(i).ProductName;
                return product == endpoint.FriendlyName || (product.Length == 31 && endpoint.FriendlyName.StartsWith(product, StringComparison.Ordinal));
            }).ToArray();
            if (indices.Length != 1) throw new IOException("Selected microphone cannot be mapped uniquely");
            input = new WaveInEvent { DeviceNumber = indices[0], WaveFormat = new WaveFormat(16000, 16, 1), BufferMilliseconds = 20, NumberOfBuffers = 3 };
            input.DataAvailable += (_, e) => DataAvailable?.Invoke(this, e);
        }
        catch { endpoint.Dispose(); throw; }
    }
    public bool Permitted(string settings)
    {
        try { return MicrophonePolicy.InputDevice(settings) == selectedName && endpoint.State == DeviceState.Active && !endpoint.AudioEndpointVolume.Mute && endpoint.AudioEndpointVolume.MasterVolumeLevelScalar > 0; }
        catch { return false; }
    }
    public void Start()
    {
        if (endpoint.AudioEndpointVolume.Mute || endpoint.AudioEndpointVolume.MasterVolumeLevelScalar <= 0) throw new IOException("Microphone muted");
        input.StartRecording();
    }
    public void Stop() => input.StopRecording();
    public void Dispose() { input.Dispose(); endpoint.Dispose(); }
}
internal sealed class Playback : IPlayback
{
    public long Until { get; }
    private readonly BufferedWaveProvider buffer;
    private readonly WaveOutEvent output;
    public Playback(long until)
    {
        Until = until;
        buffer = new BufferedWaveProvider(new WaveFormat(16000, 16, 1)) { BufferDuration = TimeSpan.FromMilliseconds(100), DiscardOnBufferOverflow = true };
        output = new WaveOutEvent { DesiredLatency = 40, NumberOfBuffers = 2 };
        try { output.Init(buffer); output.Play(); } catch { output.Dispose(); throw; }
    }
    public void Append(byte[] data, int offset, int length) { if (buffer.BufferedBytes <= 2560) buffer.AddSamples(data, offset, length); }
    public void Dispose() { output.Stop(); buffer.ClearBuffer(); output.Dispose(); }
}

internal sealed class CaptureIndicator : IDisposable, ICaptureIndicator
{
    private long until;
    private int stopped;
    public CaptureIndicator(int gamePid)
    {
        var thread = new Thread(() => {
            using var form = new IndicatorForm();
            using var timer = new System.Windows.Forms.Timer { Interval = 50 };
            timer.Tick += (_, _) => {
                if (Volatile.Read(ref stopped) != 0) { Application.ExitThread(); return; }
                GetWindowThreadProcessId(GetForegroundWindow(), out uint pid);
                long left = Interlocked.Read(ref until) - Environment.TickCount64;
                if (left > 0 && pid == gamePid)
                {
                    form.TextLabel.Text = $"DEATHCOMM · MICRO OUVERT  {Math.Ceiling(left / 1000.0):0}s";
                    if (GetWindowRect(GetForegroundWindow(), out var rect)) form.Location = new Point(rect.Left + 24, rect.Top + 80);
                    if (!form.Visible) form.Show();
                }
                else form.Hide();
            };
            timer.Start(); Application.Run();
        }) { IsBackground = true, Name = "Deathcomm microphone indicator" };
        thread.SetApartmentState(ApartmentState.STA); thread.Start();
    }
    public void ShowUntil(long value) => Interlocked.Exchange(ref until, value);
    public void Dispose() => Interlocked.Exchange(ref stopped, 1);
    private sealed class IndicatorForm : Form
    {
        public readonly Label TextLabel = new() { AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, ForeColor = Color.White };
        public IndicatorForm()
        {
            FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true;
            StartPosition = FormStartPosition.Manual; Size = new Size(310, 38); BackColor = Color.FromArgb(110, 20, 20);
            Controls.Add(TextLabel);
        }
        protected override bool ShowWithoutActivation => true;
        protected override CreateParams CreateParams { get { var p = base.CreateParams; p.ExStyle |= 0x08000000 | 0x80 | 0x20; return p; } }
    }
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint hwnd, out uint processId);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(nint hwnd, out Rect rect);
}
