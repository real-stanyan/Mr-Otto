# 手机端语音通话的原生一半（#1356 A4，ADR-0320）：Expo 本地模块，autolinking 从 mobile/modules/ 找到它。
Pod::Spec.new do |s|
  s.name           = 'OttoSpeech'
  s.version        = '1.0.0'
  s.summary        = 'Mr Otto mobile: speech recognition, endpointing, echo cancellation and playback'
  s.description    = 'The desktop native/MrOttoSpeech helper ported as an Expo module (#1356 A4, ADR-0320).'
  s.author         = ''
  s.homepage       = 'https://github.com/real-stanyan/Mr-Otto'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'Speech'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,swift}"
end
