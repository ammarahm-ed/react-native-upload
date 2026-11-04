/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { registerBackgroundHandler } from './src/background';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);

registerBackgroundHandler();
