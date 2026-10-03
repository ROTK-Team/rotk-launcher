using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using RotkDeathcomm;
using NAudio.Wave;

static void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
string enabled = "[VoiceChat]\nProximityEnabled=1\nProximityVolume=0.5\n[Voice]\nEnable=1\nReceiveVolume=80\nMicrophoneVolume=50.000000\n";
Check(MicrophonePolicy.Allows(enabled), "enabled microphone");
Check(MicrophonePolicy.Allows(enabled + "ReceiveVolume=0\nGroupVolume=0"), "receive sliders do not authorize or disable microphone");
Check(MicrophonePolicy.InputDevice(enabled) == "Default System Device", "native default device");
Check(MicrophonePolicy.InputDevice(enabled + "[VoiceChat]\nInputDevice=Headset Mic") == "Headset Mic", "respect explicit microphone selection");
Check(MicrophonePolicy.InputDevice(enabled + "[VoiceChat]\nInputDevice=Mic A\nInputDevice=Mic B") == null, "ambiguous device is refused");
foreach (string text in new[] { "", enabled.Replace("Enable=1", "Enable=0"), enabled.Replace("50.000000", "0"),
    enabled.Replace("50.000000", "NaN"), enabled.Replace("50.000000", "Infinity"), enabled.Replace("50.000000", "101"),
    enabled.Replace("50.000000", "-5"), enabled + "Enable=1", enabled.Replace("[Voice]", "[Other]"), "[Voice]\nEnable=1" })
    Check(!MicrophonePolicy.Allows(text), "disabled, missing and malformed mic settings fail closed");
Check(!MicrophonePolicy.Allows(enabled.Replace("ProximityEnabled=1", "ProximityEnabled=0")), "disabled proximity chat does not authorize capture");
string[] disabledChatSettings = ["", enabled.Replace("Enable=1", "Enable=0"),
    enabled.Replace("ProximityEnabled=1", "ProximityEnabled=0"), enabled.Replace("ReceiveVolume=80", "ReceiveVolume=0"),
    enabled.Replace("ProximityVolume=0.5", "ProximityVolume=0"), enabled.Replace("ReceiveVolume=80", "ReceiveVolume=NaN"),
    enabled.Replace("ProximityVolume=0.5", "ProximityVolume=2"), enabled.Replace("ReceiveVolume=80", "ReceiveVolume=101"),
    enabled.Replace("ProximityEnabled=1", "ProximityEnabled=1\nProximityEnabled=0"), enabled + "ReceiveVolume=80",
    enabled.Replace("ReceiveVolume=80", ""), enabled.Replace("ProximityVolume=0.5", "")];

var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
using var tcpClient = new TcpClient();
var connecting = tcpClient.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port);
using var tcpServer = await listener.AcceptTcpClientAsync(); await connecting; listener.Stop();
using var client = WebSocket.CreateFromStream(tcpClient.GetStream(), false, null, TimeSpan.FromSeconds(10));
using var server = WebSocket.CreateFromStream(tcpServer.GetStream(), true, null, TimeSpan.FromSeconds(10));
var players = new List<FakePlayback>(); var indicator = new FakeIndicator();
bool micAllowed = false;
using var preferences = new TestPreferences(enabled);
var microphones = new List<FakeCapture>();
using var session = new DeathcommSession(client, new(1, preferences.GameRoot, "unused", "unused"), indicator,
    microphonePermission: () => Volatile.Read(ref micAllowed),
    createPlayback: until => { var p = new FakePlayback(until); lock (players) players.Add(p); return p; },
    createCapture: () => { var mic = new FakeCapture(); lock (microphones) microphones.Add(mic); return mic; });
using var cancellation = new CancellationTokenSource();
var running = session.Run(cancellation.Token);
const string id = "0123456789abcdef0123456789abcdef";
async Task Send(string text) => await server.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);
byte[] audio = new byte[656]; Convert.FromHexString(id).CopyTo(audio, 0); audio[16] = 42;
await server.SendAsync(audio, WebSocketMessageType.Binary, true, CancellationToken.None);
// Malformed or hostile text frames are skipped: one bad frame must never end
// the session, because the launcher starts this helper only once per game.
await Send("");
await Send("not json");
await Send("[1]");
await Send($$"""{"id":"{{id}}"}""");
await Send($$"""{"type":"capture","id":"{{id}}","remainingMs":4000}""");
await Send($$"""{"type":"listen","id":"{{id}}","remainingMs":300}""");
await server.SendAsync(audio.AsMemory(0, 100), WebSocketMessageType.Binary, false, CancellationToken.None);
await server.SendAsync(audio.AsMemory(100), WebSocketMessageType.Binary, true, CancellationToken.None);
await Task.Delay(100);
lock (players) Check(players.Count == 1 && players[0].Frames == 1, "muted microphone does not block authorized reception; unsolicited audio is ignored");
Check(indicator.Openings == 0, "a capture request cannot activate a disabled microphone");
await Send($$"""{"type":"stop","id":"{{id}}"}""");
await server.SendAsync(audio, WebSocketMessageType.Binary, true, CancellationToken.None);
await Task.Delay(60);
lock (players) Check(players[0].Closed && players[0].Frames == 1, "stop discards playback and late frames");
await Send($$"""{"type":"listen","id":"{{id}}","remainingMs":60}""");
await Task.Delay(160);
lock (players) Check(players.Count == 2 && players[1].Closed, "client deadline closes output without waiting for a server stop");
async Task Eventually(Func<bool> condition, string message)
{
    long until = Environment.TickCount64 + 2000;
    while (!condition() && Environment.TickCount64 < until) await Task.Delay(10);
    Check(condition(), message);
}
// Exercise the real preferences-file path, without an injected receive policy.
// Missing preferences and all native chat mute combinations must still allow
// server-authorized listening, while capture remains denied.
foreach (string? settings in new string?[] { enabled, null }.Concat(disabledChatSettings))
{
    preferences.Write(settings);
    int before; lock (players) before = players.Count;
    await Send($$"""{"type":"listen","id":"{{id}}","remainingMs":4000}""");
    await server.SendAsync(audio, WebSocketMessageType.Binary, true, CancellationToken.None);
    await Eventually(() => { lock (players) return players.Count == before + 1 && players[^1].Frames == 1; }, "deathcomm plays independently of native chat preferences");
    FakePlayback playback; lock (players) playback = players[^1];
    await Send($$"""{"type":"stop","id":"{{id}}"}""");
    await Eventually(() => playback.Closed, "server stop still closes independent playback");
    Check(preferences.Read() == settings, "listening never edits or recreates native preferences");
}
Check(indicator.Openings == 0 && microphones.Count == 0, "listening does not open the killer's microphone");
preferences.Write(enabled);
int activeIndex; lock (players) activeIndex = players.Count;
await Send($$"""{"type":"listen","id":"{{id}}","remainingMs":4000}""");
await Eventually(() => { lock (players) return players.Count == activeIndex + 1; }, "active reaction opens output");
FakePlayback activePlayback; lock (players) activePlayback = players[activeIndex];
int expectedFrames = 0;
foreach (string? settings in disabledChatSettings.Skip(1).Take(4).Cast<string?>().Append(null))
{
    preferences.Write(settings);
    await Task.Delay(60); // Allow the normal preference-monitor tick to run.
    await server.SendAsync(audio, WebSocketMessageType.Binary, true, CancellationToken.None);
    expectedFrames++;
    await Eventually(() => activePlayback.Frames == expectedFrames, "native mute changes do not interrupt a granted reaction");
    Check(!activePlayback.Closed && preferences.Read() == settings, "playback keeps settings untouched");
}
await Send($$"""{"type":"stop","id":"{{id}}"}""");
await Eventually(() => activePlayback.Closed, "server stop clears active playback after preference changes");
preferences.Write(enabled);
Volatile.Write(ref micAllowed, true);
await Send($$"""{"type":"capture","id":"{{id}}","remainingMs":4000}""");
await Task.Delay(60);
FakeCapture microphone; lock (microphones) { Check(microphones.Count == 1, "capture starts only after authorization"); microphone = microphones[0]; }
microphone.Push();
using var receiveTimeout = new CancellationTokenSource(1000);
byte[] received = new byte[1000];
var result = await server.ReceiveAsync(received.AsMemory(), receiveTimeout.Token);
Check(result.Count == 656 && result.MessageType == WebSocketMessageType.Binary &&
    received.AsSpan(0, 16).SequenceEqual(Convert.FromHexString(id)) && received[16] == 7, "authorized automatic capture is grant-tagged PCM");
Volatile.Write(ref micAllowed, false); await Task.Delay(70);
Check(microphone.Closed, "changing microphone permission closes capture during the four-second window");
Check(indicator.Openings == 1, "automatic microphone is indicated");
cancellation.Cancel();
try { await running; } catch (Exception e) when (e is OperationCanceledException or WebSocketException) { }
Console.WriteLine("PASS: microphone authorization, independent deathcomm reception with native chat/proximity disabled or muted, untouched preferences, unsolicited/late audio rejection, malformed text frame skipping, stop and deadline cleanup (no physical audio devices used).");

sealed class FakePlayback(long until) : IPlayback
{
    public long Until { get; } = until;
    public int Frames;
    public volatile bool Closed;
    public void Append(byte[] data, int offset, int length) { if (Closed) throw new Exception("closed playback"); Interlocked.Increment(ref Frames); }
    public void Dispose() => Closed = true;
}
sealed class FakeIndicator : ICaptureIndicator
{
    public int Openings;
    public void ShowUntil(long value) { if (value > 0) Interlocked.Increment(ref Openings); }
}
sealed class FakeCapture : ICapture
{
    public event EventHandler<WaveInEventArgs>? DataAvailable;
    public bool Closed;
    public bool Permitted(string settings) => !Closed;
    public void Start() { }
    public void Stop() => Closed = true;
    public void Dispose() => Closed = true;
    public void Push() => DataAvailable?.Invoke(this, new WaveInEventArgs(Enumerable.Repeat((byte)7, 640).ToArray(), 640));
}

sealed class TestPreferences : IDisposable
{
    public string GameRoot { get; } = Path.Combine(AppContext.BaseDirectory, "deathcomm-proof-" + Guid.NewGuid().ToString("N"));
    private string SettingsPath => Path.Combine(GameRoot, "UserOptions.ini");
    public TestPreferences(string text) { Directory.CreateDirectory(GameRoot); Write(text); }
    public void Write(string? text) { if (text == null) File.Delete(SettingsPath); else File.WriteAllText(SettingsPath, text); }
    public string? Read() => File.Exists(SettingsPath) ? File.ReadAllText(SettingsPath) : null;
    public void Dispose() { File.Delete(SettingsPath); Directory.Delete(GameRoot); }
}
