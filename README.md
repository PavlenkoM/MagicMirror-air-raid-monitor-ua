#  MagicMirror-air-raid-monitor-ua

This is an extension for the [MagicMirror](https://github.com/MichMich/MagicMirror). It shows the current status of air raid sirens in Ukraine.
Based on data from [sirens.in.ua](https://sirens.in.ua/).

<img width="328" alt="Знімок екрана 2022-05-31 о 22 59 29" src="https://user-images.githubusercontent.com/9430298/171278252-afbf185c-b40f-4214-8292-6fa9d43af002.png">


## Installation
1. Install and configure [MagicMirror](https://docs.magicmirror.builders).
2. Navigate into your MagicMirror's `modules` folder and execute `git clone https://github.com/PavlenkoM/MagicMirror-air-raid-monitor-ua.git`
3. To use this module, add it to the modules array in the `config/config.js` file:
````javascript
modules: [
	{
		module: 'MagicMirror-air-raid-monitor-ua',
		config: {
      apiKey: 'YOUR_API_KEY',
			updateInterval: 60
		}
	}
]
````

## Configuration options
The following properties can be configured:

| Option | Description |
| --- | --- |
| `apiKey` | Your API key for accessing the air raid data. |
| `updateInterval` | Interval of updating information about air raids in Ukraine. Value in seconds. Min value 60 seconds — the ukrainealarm.com API rate-limits each key to about one request per minute and answers faster polling with empty `401` responses. |

#### Version of this widget for other platforms:
* [Windows](https://github.com/dr-mod/air-raid-widget-windows)
* [Linux](https://github.com/dr-mod/air-raid-widget-linux)
* [macOS](https://github.com/dr-mod/air-raid-widget-macos)
* [RaspberryPi](https://github.com/dr-mod/air-raid-monitor)

## License
This module is licensed under the [MIT License](LICENSE.md).
