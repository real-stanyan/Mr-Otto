// polyfill 必须排在最前:supabase-js 的 PKCE 要 crypto.getRandomValues,而 Hermes 没有
// (配对那条 @noble/* 已经随 #1356 删了,这个 polyfill 留着是给 PKCE 用的)
import "./src/polyfills.js";

import { registerRootComponent } from 'expo';

import App from './App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
