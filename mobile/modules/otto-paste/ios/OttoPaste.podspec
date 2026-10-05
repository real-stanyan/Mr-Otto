# 输入框收图片粘贴（#1645）：RN 的 RCTUITextView 只认文字，这里挂住它的粘贴入口，图片转给 JS。Expo 本地模块，autolinking 从 mobile/modules/ 找到它。
Pod::Spec.new do |s|
  s.name           = 'OttoPaste'
  s.version        = '1.0.0'
  s.summary        = 'Mr Otto mobile: paste images into chat composers'
  s.description    = 'Long-press paste / keyboard "Paste from Screenshots" with an image lands as a chat image (#1645).'
  s.author         = ''
  s.homepage       = 'https://github.com/real-stanyan/Mr-Otto'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'UIKit', 'UniformTypeIdentifiers'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,swift}"
end
