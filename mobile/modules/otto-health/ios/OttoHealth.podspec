# Apple 健康（#1656）：读 HealthKit 按天汇总给智能体。Expo 本地模块，autolinking 从 mobile/modules/ 找到它。
Pod::Spec.new do |s|
  s.name           = 'OttoHealth'
  s.version        = '1.0.0'
  s.summary        = 'Mr Otto mobile: read Apple Health daily summaries for agents'
  s.description    = 'Read-only HealthKit queries aggregated per day, answered over the cloud session (#1656).'
  s.author         = ''
  s.homepage       = 'https://github.com/real-stanyan/Mr-Otto'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'HealthKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,swift}"
end
