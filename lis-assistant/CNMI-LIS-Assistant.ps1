# CNMI LIS Assistant - local-only data entry helper
# Loads the CSV exported by CNMI Blood Mobile. No data is uploaded.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $base 'lis-field-order.json'
$config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
$rows = @()
$currentIndex = 0
$currentFieldIndex = 0

$form = New-Object System.Windows.Forms.Form
$form.Text = 'CNMI LIS Assistant — Local Only'
$form.Size = New-Object System.Drawing.Size(1100,720)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object System.Drawing.Font('Segoe UI',10)

$top = New-Object System.Windows.Forms.Panel
$top.Dock = 'Top'; $top.Height = 110; $top.Padding = '12,10,12,8'
$form.Controls.Add($top)

$btnOpen = New-Object System.Windows.Forms.Button
$btnOpen.Text = '1) เปิดไฟล์ CNMI-LIS-*.csv'; $btnOpen.Width=220; $btnOpen.Height=38; $btnOpen.Left=12; $btnOpen.Top=12
$top.Controls.Add($btnOpen)

$lblFile = New-Object System.Windows.Forms.Label
$lblFile.Text='ยังไม่ได้เลือกไฟล์'; $lblFile.AutoSize=$true; $lblFile.Left=245; $lblFile.Top=21
$top.Controls.Add($lblFile)

$lblWarn = New-Object System.Windows.Forms.Label
$lblWarn.Text='ก่อนใช้ Auto TAB ต้องทดสอบกับข้อมูลจำลอง 1 ราย และตรวจลำดับช่องให้ตรงกับ LIS จริง'; $lblWarn.ForeColor='DarkRed'; $lblWarn.AutoSize=$true; $lblWarn.Left=12; $lblWarn.Top=62
$top.Controls.Add($lblWarn)

$grid = New-Object System.Windows.Forms.DataGridView
$grid.Dock='Fill'; $grid.ReadOnly=$true; $grid.SelectionMode='FullRowSelect'; $grid.MultiSelect=$false; $grid.AutoSizeColumnsMode='DisplayedCells'; $grid.AllowUserToAddRows=$false
$form.Controls.Add($grid)

$bottom = New-Object System.Windows.Forms.Panel
$bottom.Dock='Bottom'; $bottom.Height=150; $bottom.Padding='12,8,12,8'
$form.Controls.Add($bottom)

$lblSelected = New-Object System.Windows.Forms.Label
$lblSelected.Text='ยังไม่ได้เลือกรายการ'; $lblSelected.AutoSize=$true; $lblSelected.Left=12; $lblSelected.Top=12; $lblSelected.Font=New-Object System.Drawing.Font('Segoe UI',11,[System.Drawing.FontStyle]::Bold)
$bottom.Controls.Add($lblSelected)

$lblNext = New-Object System.Windows.Forms.Label
$lblNext.Text='โหมดคัดลอกทีละช่อง: -'; $lblNext.AutoSize=$true; $lblNext.Left=12; $lblNext.Top=44
$bottom.Controls.Add($lblNext)

$btnNext = New-Object System.Windows.Forms.Button
$btnNext.Text='คัดลอกช่องถัดไป'; $btnNext.Width=170; $btnNext.Height=40; $btnNext.Left=12; $btnNext.Top=78; $btnNext.Enabled=$false
$bottom.Controls.Add($btnNext)

$btnReset = New-Object System.Windows.Forms.Button
$btnReset.Text='เริ่มช่องแรกใหม่'; $btnReset.Width=140; $btnReset.Height=40; $btnReset.Left=192; $btnReset.Top=78; $btnReset.Enabled=$false
$bottom.Controls.Add($btnReset)

$btnAuto = New-Object System.Windows.Forms.Button
$btnAuto.Text='Auto TAB รายที่เลือก'; $btnAuto.Width=190; $btnAuto.Height=40; $btnAuto.Left=355; $btnAuto.Top=78; $btnAuto.Enabled=$false; $btnAuto.BackColor='LightSteelBlue'
$bottom.Controls.Add($btnAuto)

$btnOpenConfig = New-Object System.Windows.Forms.Button
$btnOpenConfig.Text='แก้ลำดับช่อง'; $btnOpenConfig.Width=140; $btnOpenConfig.Height=40; $btnOpenConfig.Left=565; $btnOpenConfig.Top=78
$bottom.Controls.Add($btnOpenConfig)

$lblCountdown = New-Object System.Windows.Forms.Label
$lblCountdown.Text=''; $lblCountdown.AutoSize=$true; $lblCountdown.Left=730; $lblCountdown.Top=88; $lblCountdown.ForeColor='DarkBlue'; $lblCountdown.Font=New-Object System.Drawing.Font('Segoe UI',11,[System.Drawing.FontStyle]::Bold)
$bottom.Controls.Add($lblCountdown)

function Get-SelectedRow {
    if ($grid.SelectedRows.Count -eq 0) { return $null }
    $idx = $grid.SelectedRows[0].Index
    if ($idx -lt 0 -or $idx -ge $rows.Count) { return $null }
    return $rows[$idx]
}

function Refresh-Selected {
    $row = Get-SelectedRow
    if ($null -eq $row) { return }
    $script:currentIndex = $grid.SelectedRows[0].Index
    $script:currentFieldIndex = 0
    $lblSelected.Text = "เลือก: DN $($row.DN)  $($row.Prefix)$($row.FirstName) $($row.LastName)"
    $btnNext.Enabled=$true; $btnReset.Enabled=$true; $btnAuto.Enabled=$true
    Update-NextLabel
}

function Update-NextLabel {
    $row = Get-SelectedRow
    if ($null -eq $row) { return }
    if ($currentFieldIndex -ge $config.fields.Count) {
        $lblNext.Text='ครบทุกช่องแล้ว'
        return
    }
    $field = [string]$config.fields[$currentFieldIndex]
    $value = [string]$row.$field
    $shown = if ($field -eq 'ID_Card' -and $value.Length -ge 4) { '*********' + $value.Substring($value.Length-4) } else { $value }
    $lblNext.Text = "ช่องถัดไป: $field = $shown"
}

$btnOpen.Add_Click({
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Filter='CNMI LIS CSV (*.csv)|*.csv|CSV files (*.csv)|*.csv'
    if ($dlg.ShowDialog() -ne 'OK') { return }
    try {
        $script:rows = @(Import-Csv -Path $dlg.FileName -Encoding UTF8)
        if ($rows.Count -eq 0) { throw 'ไฟล์ไม่มีข้อมูล' }
        $grid.DataSource = $rows
        $lblFile.Text = "$($dlg.FileName) · $($rows.Count) รายการ"
        $grid.Rows[0].Selected=$true
        Refresh-Selected
    } catch {
        [System.Windows.Forms.MessageBox]::Show("เปิดไฟล์ไม่สำเร็จ: $($_.Exception.Message)",'CNMI LIS Assistant','OK','Error')
    }
})

$grid.Add_SelectionChanged({ if ($rows.Count -gt 0) { Refresh-Selected } })

$btnReset.Add_Click({ $script:currentFieldIndex=0; Update-NextLabel })

$btnNext.Add_Click({
    $row = Get-SelectedRow
    if ($null -eq $row -or $currentFieldIndex -ge $config.fields.Count) { return }
    $field = [string]$config.fields[$currentFieldIndex]
    $value = [string]$row.$field
    [System.Windows.Forms.Clipboard]::SetText($value)
    $script:currentFieldIndex++
    Update-NextLabel
})

$btnOpenConfig.Add_Click({ Start-Process notepad.exe $configPath })

$btnAuto.Add_Click({
    $row = Get-SelectedRow
    if ($null -eq $row) { return }
    $msg = "ระบบจะรอ 5 วินาที แล้วพิมพ์ข้อมูลลงหน้าต่างที่กำลังใช้งาน โดยกด TAB ระหว่างช่อง`r`n`r`nต้องคลิกช่องแรกของ LIS ภายใน 5 วินาที`r`nกรุณาทดสอบกับข้อมูลจำลองก่อนใช้จริง"
    if ([System.Windows.Forms.MessageBox]::Show($msg,'ยืนยัน Auto TAB','YesNo','Warning') -ne 'Yes') { return }
    $form.WindowState='Minimized'
    for ($i=5; $i -ge 1; $i--) { $lblCountdown.Text="เริ่มใน $i"; [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Seconds 1 }
    try {
        foreach ($field in $config.fields) {
            $value = [string]$row.([string]$field)
            [System.Windows.Forms.Clipboard]::SetText($value)
            [System.Windows.Forms.SendKeys]::SendWait('^v')
            Start-Sleep -Milliseconds ([int]$config.delayMs)
            [System.Windows.Forms.SendKeys]::SendWait('{TAB}')
            Start-Sleep -Milliseconds ([int]$config.delayMs)
        }
    } catch {
        [System.Windows.Forms.MessageBox]::Show("Auto TAB หยุด: $($_.Exception.Message)",'CNMI LIS Assistant','OK','Error')
    } finally {
        $form.WindowState='Normal'; $form.Activate(); $lblCountdown.Text='เสร็จแล้ว — ตรวจสอบข้อมูลใน LIS ก่อนบันทึก'
    }
})

[void]$form.ShowDialog()
