# CNMI Blood Mobile - Local Thai ID Smart Card Bridge
# Windows PowerShell 5.1+, no cloud upload, listens only on 127.0.0.1:17345
# Close this window after finishing the mobile unit.

$ErrorActionPreference = 'Stop'
$Port = 17345

Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class ThaiCardData {
    public string Reader { get; set; }
    public string CitizenId { get; set; }
    public string Prefix { get; set; }
    public string FirstName { get; set; }
    public string LastName { get; set; }
    public string ThFullName { get; set; }
    public string EnFullName { get; set; }
    public string BirthDate { get; set; }
    public string Gender { get; set; }
    public string Address { get; set; }
}

public static class CnmiPcsc {
    private const uint SCARD_SCOPE_USER = 0;
    private const uint SCARD_SHARE_SHARED = 2;
    private const uint SCARD_PROTOCOL_T0 = 1;
    private const uint SCARD_PROTOCOL_T1 = 2;
    private const uint SCARD_LEAVE_CARD = 0;

    [StructLayout(LayoutKind.Sequential)]
    private struct SCARD_IO_REQUEST {
        public uint dwProtocol;
        public uint cbPciLength;
    }

    [DllImport("winscard.dll")]
    private static extern int SCardEstablishContext(uint dwScope, IntPtr pvReserved1, IntPtr pvReserved2, out IntPtr phContext);

    [DllImport("winscard.dll")]
    private static extern int SCardReleaseContext(IntPtr hContext);

    [DllImport("winscard.dll", CharSet = CharSet.Unicode)]
    private static extern int SCardListReaders(IntPtr hContext, string mszGroups, IntPtr mszReaders, ref int pcchReaders);

    [DllImport("winscard.dll", CharSet = CharSet.Unicode)]
    private static extern int SCardConnect(IntPtr hContext, string szReader, uint dwShareMode, uint dwPreferredProtocols, out IntPtr phCard, out uint pdwActiveProtocol);

    [DllImport("winscard.dll")]
    private static extern int SCardDisconnect(IntPtr hCard, uint dwDisposition);

    [DllImport("winscard.dll")]
    private static extern int SCardTransmit(IntPtr hCard, ref SCARD_IO_REQUEST pioSendPci, byte[] pbSendBuffer, int cbSendLength, IntPtr pioRecvPci, byte[] pbRecvBuffer, ref int pcbRecvLength);

    private static void Check(int rc, string operation) {
        if (rc != 0) throw new InvalidOperationException(operation + " failed (0x" + rc.ToString("X8") + ")");
    }

    public static string[] ListReaders() {
        IntPtr context = IntPtr.Zero;
        try {
            Check(SCardEstablishContext(SCARD_SCOPE_USER, IntPtr.Zero, IntPtr.Zero, out context), "SCardEstablishContext");
            int chars = 0;
            int rc = SCardListReaders(context, null, IntPtr.Zero, ref chars);
            if (rc != 0 || chars <= 1) return new string[0];
            IntPtr buffer = Marshal.AllocHGlobal(chars * 2);
            try {
                Check(SCardListReaders(context, null, buffer, ref chars), "SCardListReaders");
                var result = new List<string>();
                var current = new StringBuilder();
                for (int i = 0; i < chars; i++) {
                    char c = (char)Marshal.ReadInt16(buffer, i * 2);
                    if (c == '\0') {
                        if (current.Length == 0) break;
                        result.Add(current.ToString());
                        current.Clear();
                    } else current.Append(c);
                }
                return result.ToArray();
            } finally { Marshal.FreeHGlobal(buffer); }
        } finally {
            if (context != IntPtr.Zero) SCardReleaseContext(context);
        }
    }

    private static byte[] TransmitRaw(IntPtr card, uint protocol, byte[] command) {
        var pci = new SCARD_IO_REQUEST { dwProtocol = protocol, cbPciLength = (uint)Marshal.SizeOf(typeof(SCARD_IO_REQUEST)) };
        byte[] receive = new byte[4096];
        int receiveLength = receive.Length;
        Check(SCardTransmit(card, ref pci, command, command.Length, IntPtr.Zero, receive, ref receiveLength), "SCardTransmit");
        byte[] output = new byte[receiveLength];
        Array.Copy(receive, output, receiveLength);
        return output;
    }

    private static byte[] Send(IntPtr card, uint protocol, byte[] command) {
        byte[] response = TransmitRaw(card, protocol, command);
        if (response.Length < 2) throw new InvalidOperationException("Card returned an incomplete response");
        byte sw1 = response[response.Length - 2];
        byte sw2 = response[response.Length - 1];
        if (sw1 == 0x61) {
            response = TransmitRaw(card, protocol, new byte[] { 0x00, 0xC0, 0x00, 0x00, sw2 });
            if (response.Length < 2) throw new InvalidOperationException("GET RESPONSE returned incomplete data");
            sw1 = response[response.Length - 2]; sw2 = response[response.Length - 1];
        }
        if (sw1 == 0x6C) {
            byte[] retry = (byte[])command.Clone();
            retry[retry.Length - 1] = sw2;
            response = TransmitRaw(card, protocol, retry);
            sw1 = response[response.Length - 2]; sw2 = response[response.Length - 1];
        }
        if (!(sw1 == 0x90 && sw2 == 0x00)) throw new InvalidOperationException("Card status 0x" + sw1.ToString("X2") + sw2.ToString("X2"));
        byte[] data = new byte[response.Length - 2];
        Array.Copy(response, data, data.Length);
        return data;
    }

    private static string DecodeThai(byte[] bytes) {
        int length = bytes.Length;
        while (length > 0 && (bytes[length - 1] == 0x00 || bytes[length - 1] == 0xFF || bytes[length - 1] == 0x20)) length--;
        string text = Encoding.GetEncoding(874).GetString(bytes, 0, length);
        return text.Replace('\0', ' ').Trim();
    }

    private static string ReadText(IntPtr card, uint protocol, byte[] command) {
        return DecodeThai(Send(card, protocol, command));
    }

    private static string FormatCardDate(string yyyymmdd) {
        string digits = "";
        foreach (char c in (yyyymmdd ?? "")) if (char.IsDigit(c)) digits += c;
        if (digits.Length < 8) return yyyymmdd ?? "";
        return digits.Substring(6, 2) + "-" + digits.Substring(4, 2) + "-" + digits.Substring(0, 4);
    }

    private static string CleanHashes(string value) {
        return (value ?? "").Replace("#", " ").Replace("  ", " ").Trim();
    }

    public static ThaiCardData ReadThaiCard() {
        IntPtr context = IntPtr.Zero;
        IntPtr card = IntPtr.Zero;
        try {
            Check(SCardEstablishContext(SCARD_SCOPE_USER, IntPtr.Zero, IntPtr.Zero, out context), "SCardEstablishContext");
            string[] readers = ListReaders();
            if (readers.Length == 0) throw new InvalidOperationException("ไม่พบเครื่องอ่านบัตร กรุณาตรวจสาย USB และ Windows Smart Card service");
            uint protocol;
            int rc = SCardConnect(context, readers[0], SCARD_SHARE_SHARED, SCARD_PROTOCOL_T0 | SCARD_PROTOCOL_T1, out card, out protocol);
            if (rc != 0) throw new InvalidOperationException("ยังไม่พบบัตรประชาชนในเครื่องอ่าน หรือบัตรเสียบไม่สุด (0x" + rc.ToString("X8") + ")");

            Send(card, protocol, new byte[] { 0x00,0xA4,0x04,0x00,0x08,0xA0,0x00,0x00,0x00,0x54,0x48,0x00,0x01 });
            string cid = ReadText(card, protocol, new byte[] { 0x80,0xB0,0x00,0x04,0x02,0x00,0x0D });
            string thNameRaw = ReadText(card, protocol, new byte[] { 0x80,0xB0,0x00,0x11,0x02,0x00,0x64 });
            string enNameRaw = ReadText(card, protocol, new byte[] { 0x80,0xB0,0x00,0x75,0x02,0x00,0x64 });
            string birth = ReadText(card, protocol, new byte[] { 0x80,0xB0,0x00,0xD9,0x02,0x00,0x08 });
            string sex = ReadText(card, protocol, new byte[] { 0x80,0xB0,0x00,0xE1,0x02,0x00,0x01 });
            string addressRaw = ReadText(card, protocol, new byte[] { 0x80,0xB0,0x15,0x79,0x02,0x00,0x64 });

            string[] nameParts = thNameRaw.Split(new char[] {'#'}, StringSplitOptions.RemoveEmptyEntries);
            string prefix = nameParts.Length > 0 ? nameParts[0].Trim() : "";
            string first = nameParts.Length > 1 ? nameParts[1].Trim() : "";
            string last = nameParts.Length > 2 ? nameParts[nameParts.Length - 1].Trim() : "";

            return new ThaiCardData {
                Reader = readers[0], CitizenId = cid.Trim(), Prefix = prefix, FirstName = first, LastName = last,
                ThFullName = CleanHashes(thNameRaw), EnFullName = CleanHashes(enNameRaw), BirthDate = FormatCardDate(birth),
                Gender = sex.Trim() == "1" ? "ชาย" : (sex.Trim() == "2" ? "หญิง" : sex.Trim()), Address = CleanHashes(addressRaw)
            };
        } finally {
            if (card != IntPtr.Zero) SCardDisconnect(card, SCARD_LEAVE_CARD);
            if (context != IntPtr.Zero) SCardReleaseContext(context);
        }
    }
}
"@

function Test-OriginAllowed([string]$Origin) {
    if ([string]::IsNullOrWhiteSpace($Origin) -or $Origin -eq 'null') { return $true }
    if ($Origin -eq 'https://mobile.cnmiblood.com') { return $true }
    if ($Origin -match '^http://(127\.0\.0\.1|localhost)(:\d+)?$') { return $true }
    return $false
}

function Send-HttpJson($Stream, [int]$StatusCode, $Object, [string]$Origin = '') {
    $json = $Object | ConvertTo-Json -Depth 8 -Compress
    $body = [Text.Encoding]::UTF8.GetBytes($json)
    $statusText = if ($StatusCode -eq 200) { 'OK' } elseif ($StatusCode -eq 204) { 'No Content' } elseif ($StatusCode -eq 403) { 'Forbidden' } else { 'Error' }
    $corsOrigin = if (Test-OriginAllowed $Origin) { if ([string]::IsNullOrWhiteSpace($Origin)) { '*' } else { $Origin } } else { 'null' }
    $headers = "HTTP/1.1 $StatusCode $statusText`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: $($body.Length)`r`nAccess-Control-Allow-Origin: $corsOrigin`r`nAccess-Control-Allow-Methods: GET, OPTIONS`r`nAccess-Control-Allow-Headers: Content-Type, Access-Control-Request-Private-Network`r`nAccess-Control-Allow-Private-Network: true`r`nAccess-Control-Max-Age: 600`r`nVary: Origin`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
    $headerBytes = [Text.Encoding]::ASCII.GetBytes($headers)
    $Stream.Write($headerBytes, 0, $headerBytes.Length)
    if ($body.Length -gt 0) { $Stream.Write($body, 0, $body.Length) }
    $Stream.Flush()
}

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$listener.Start()
$host.UI.RawUI.WindowTitle = 'CNMI Smart Card Bridge - uTrust 2700R'
Write-Host ''
Write-Host 'CNMI Smart Card Bridge พร้อมใช้งาน' -ForegroundColor Green
Write-Host "URL: http://127.0.0.1:$Port" -ForegroundColor Cyan
Write-Host 'รองรับเฉพาะ mobile.cnmiblood.com และ localhost' -ForegroundColor Yellow
Write-Host 'ห้ามปิดหน้าต่างนี้ระหว่างอ่านบัตร กด Ctrl+C เพื่อหยุด' -ForegroundColor Yellow
Write-Host ''

try {
    while ($true) {
        $client = $listener.AcceptTcpClient()
        try {
            $client.ReceiveTimeout = 5000
            $stream = $client.GetStream()
            $buffer = New-Object byte[] 8192
            $received = 0
            do {
                $n = $stream.Read($buffer, $received, $buffer.Length - $received)
                if ($n -le 0) { break }
                $received += $n
                $text = [Text.Encoding]::ASCII.GetString($buffer, 0, $received)
            } while ($received -lt $buffer.Length -and $text -notmatch "`r`n`r`n")

            $request = [Text.Encoding]::ASCII.GetString($buffer, 0, $received)
            $lines = $request -split "`r`n"
            $first = $lines[0] -split ' '
            $method = $first[0]
            $path = if ($first.Length -gt 1) { $first[1] } else { '/' }
            $originLine = $lines | Where-Object { $_ -match '^Origin:' } | Select-Object -First 1
            $origin = if ($originLine) { ($originLine -replace '^Origin:\s*','').Trim() } else { '' }

            if (-not (Test-OriginAllowed $origin)) {
                Send-HttpJson $stream 403 @{ status='error'; message='Origin ไม่ได้รับอนุญาต' } $origin
                continue
            }
            if ($method -eq 'OPTIONS') {
                Send-HttpJson $stream 204 @{} $origin
                continue
            }
            if ($path -like '/health*') {
                $readers = [CnmiPcsc]::ListReaders()
                Send-HttpJson $stream 200 @{ status='success'; bridge='CNMI Smart Card Bridge'; readers=$readers; time=(Get-Date).ToString('s') } $origin
                continue
            }
            if ($path -like '/read-card*') {
                try {
                    $card = [CnmiPcsc]::ReadThaiCard()
                    Write-Host "อ่านบัตรสำเร็จ: *********$($card.CitizenId.Substring([Math]::Max(0,$card.CitizenId.Length-4)))" -ForegroundColor Green
                    Send-HttpJson $stream 200 @{ status='success'; card=$card } $origin
                } catch {
                    Write-Host "อ่านบัตรไม่สำเร็จ: $($_.Exception.Message)" -ForegroundColor Red
                    Send-HttpJson $stream 500 @{ status='error'; message=$_.Exception.Message } $origin
                }
                continue
            }
            Send-HttpJson $stream 404 @{ status='error'; message='Not found' } $origin
        } catch {
            try { Send-HttpJson $stream 500 @{ status='error'; message=$_.Exception.Message } '' } catch {}
        } finally {
            if ($stream) { $stream.Dispose() }
            $client.Close()
        }
    }
} finally {
    $listener.Stop()
}
