# 系统来电的原生一半（#1428）：PushKit 收 VoIP 推送、CallKit 画系统来电。Expo 本地模块，autolinking 从 mobile/modules/ 找到它。
Pod::Spec.new do |s|
  s.name           = 'OttoCall'
  s.version        = '1.0.0'
  s.summary        = 'Mr Otto mobile: VoIP push + CallKit incoming calls'
  s.description    = 'Agent callbacks as real system calls (#1428).'
  s.author         = ''
  s.homepage       = 'https://github.com/real-stanyan/Mr-Otto'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AVFoundation', 'CallKit', 'PushKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,swift}"
end
