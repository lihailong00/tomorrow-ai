param(
  [string]$JavaHome = 'D:/Program Files/Android/Android Studio/jbr',
  [string]$AndroidHome = 'D:/Android/Sdk'
)
$ErrorActionPreference = 'Stop'
$alarmRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$alarmCache = Join-Path $env:USERPROFILE '.gradle/caches'
function Find-AlarmJar([string]$Relative, [string]$Name) {
  $jar = Get-ChildItem -LiteralPath (Join-Path $alarmCache ('modules-2/files-2.1/' + $Relative)) -Filter $Name -Recurse -File | Select-Object -First 1
  if (-not $jar) { throw ('Existing shared dependency missing: ' + $Relative + '/' + $Name) }
  return $jar.FullName
}
$compiler = Find-AlarmJar 'org.jetbrains.kotlin/kotlin-compiler-embeddable/2.1.20' 'kotlin-compiler-embeddable-2.1.20.jar'
$stdlib = Find-AlarmJar 'org.jetbrains.kotlin/kotlin-stdlib/2.1.20' 'kotlin-stdlib-2.1.20.jar'
$script = Find-AlarmJar 'org.jetbrains.kotlin/kotlin-script-runtime/2.1.20' 'kotlin-script-runtime-2.1.20.jar'
$daemon = Find-AlarmJar 'org.jetbrains.kotlin/kotlin-daemon-embeddable/2.1.20' 'kotlin-daemon-embeddable-2.1.20.jar'
$trove = Find-AlarmJar 'org.jetbrains.intellij.deps/trove4j/1.0.20200330' 'trove4j-1.0.20200330.jar'
$coroutines = Find-AlarmJar 'org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm/1.9.0' 'kotlinx-coroutines-core-jvm-1.9.0.jar'
$annotations = Find-AlarmJar 'org.jetbrains/annotations/23.0.0' 'annotations-23.0.0.jar'
$junit = Find-AlarmJar 'junit/junit/4.13.2' 'junit-4.13.2.jar'
$hamcrest = Find-AlarmJar 'org.hamcrest/hamcrest-core/1.3' 'hamcrest-core-1.3.jar'
$react = Get-ChildItem -LiteralPath (Join-Path $alarmCache '9.0.0/transforms') -Filter 'react-android-0.82.1-release-api.jar' -File -Recurse | Select-Object -First 1
if (-not $react) { throw 'The existing React Native Android API jar was not found; this check never downloads dependencies.' }
$alarmOut = Join-Path $alarmRoot 'artifacts/phone-alarms/native-check'
New-Item -ItemType Directory -Force -Path $alarmOut | Out-Null
$alarmJar = Join-Path $alarmOut 'alarm-check.jar'
$compilerClassPath = @($compiler, $stdlib, $script, $daemon, $trove, $coroutines, $annotations) -join [IO.Path]::PathSeparator
$sourceClassPath = @($stdlib, (Join-Path $AndroidHome 'platforms/android-36/android.jar'), $react.FullName, $junit, $annotations) -join [IO.Path]::PathSeparator
$alarmSources = @(
  (Join-Path $alarmRoot 'apps/mobile/android/app/src/main/java/com/tomorrowai/PhoneAlarmPolicy.kt'),
  (Join-Path $alarmRoot 'apps/mobile/android/app/src/main/java/com/tomorrowai/PhoneAlarmsModule.kt'),
  (Join-Path $alarmRoot 'apps/mobile/android/app/src/test/java/com/tomorrowai/PhoneAlarmPolicyTest.kt')
)
& (Join-Path $JavaHome 'bin/java.exe') '-Xmx512m' '-cp' $compilerClassPath 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler' '-no-stdlib' '-no-reflect' '-jvm-target' '17' '-classpath' $sourceClassPath '-d' $alarmJar @alarmSources
if ($LASTEXITCODE -ne 0) { throw 'Alarm native source compilation failed.' }
& (Join-Path $JavaHome 'bin/java.exe') '-cp' (@($alarmJar, $stdlib, $junit, $hamcrest, $react.FullName, (Join-Path $AndroidHome 'platforms/android-36/android.jar')) -join [IO.Path]::PathSeparator) 'org.junit.runner.JUnitCore' 'com.tomorrowai.PhoneAlarmPolicyTest'
if ($LASTEXITCODE -ne 0) { throw 'Native alarm policy tests failed.' }
Write-Host ('Native module compiled; alarm policy tests passed. Output bytes: ' + (Get-Item -LiteralPath $alarmJar).Length)
