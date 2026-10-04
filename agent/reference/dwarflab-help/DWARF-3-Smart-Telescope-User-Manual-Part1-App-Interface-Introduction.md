# DWARF 3 User Manual | DWARFLAB Help Center

Source: https://help.dwarflab.com/en/docs/DWARF-3-Smart-Telescope-User-Manual-Part1-App-Interface-Introduction?product=dwarf-3
Saved: 2026-10-03 (official DWARFLAB Help Center, copied for offline reference)

## DWARF 3 User Manual

Last updated

2026-09-21

Total words

421564 words

Estimated reading

352 minutes

Download PDF

#  1\. Application Interface Introduction

## 1.1 Home

### 1.1.1 Nearby Devices

**Shows the currently connected device name.** Tap to quickly disconnect or switch to another available device. [**Section 1.1.6, Connect**](https://tinyphoton.feishu.cn/wiki/VNGwwb3OeiCGngkYhsocyRAsn4e#doxcnaUkaRxRSuU1WCUcOQNV2Uf) will explain more in detail.

### 1.1.2 Guide

Click to browse _**tutorials**_ in the help center (like this one you are looking at). Bestseller when you are using the bathroom, but not recommended before bedtime as it might inspire a sudden urge to stargaze. Note that a _**internet connection**_ is required to browse the help center.

### 1.1.3 Battery

The LED indicators show the remaining battery level. Keeping enough charge is important for normal operation:

  * **Firmware updates require at least 20% battery** and will not start below that level.
  * **Astronomical shooting automatically stops at 8% battery** to prevent an unexpected shutdown.

**Battery indicator lights:**

  * **1 light:** 0–25%; **2 lights:** 25–50%; **3 lights:** 50–75% ; **4 lights:** 75–100%

**Charging information:**

  * **Fast charging:** USB-A or USB-C to USB-C cable using a **9V or 12V** power source
  * **Slow charging:** USB-A or USB-C to USB-C cable using **5V** power
  * The device **can be used while charging** and works with **portable power banks**
  * We recommend using a USB-A or USB-C to USB-C power & data cable that supports PD2.0/PD3.0, with fast charging capabilities of 12V/2A (24W). With fast charging, the battery icon shows double lightning. Always remember to charge your device for your stargazing plans fully.

**Recommended charging temperature:** Charge the device in environments between **0°C and 45°C (32°F–113°F)** for safe and efficient charging.

> **Operating and Charging Temperature Explained** The DWARF is designed to operate safely in temperatures between **–10°C (14°F) and 60°C (140°F)**.
> 
>   * **Cold conditions:** When temperatures drop **below 0°C (32°F)** , the device can still be used normally. However, **battery charging may slow down significantly or pause altogether** until the temperature rises. This is normal behavior and protects the battery.
>   * **Hot conditions:** If the **battery temperature exceeds 45°C (113°F)** , charging is **automatically disabled** to prevent overheating. You can still use the device, but it will not charge until it cools down.
>   * **Temperature shown in the app:** The temperature displayed in the app is the real-time temperature of the **telephoto camera inside the camera module**. It is not the battery NTC temperature and should not be used to determine the shutdown threshold.
>   * **Overheat protection:** DWARF will automatically shut down when the **battery NTC temperature exceeds 65°C (149°F)** to protect the device.
> 

> 
> **Note:** The telephoto camera and the battery NTC sensor are located in different parts of the device. There is no fixed temperature difference between their readings. If the app displays an unusually high camera temperature, please provide device logs for further diagnosis. In short: the DWARF is built to protect itself. Cold affects charging speed, heat can stop charging, and extreme heat will trigger a shutdown to prevent damage.

### 1.1.4 Remaining Storage

For your convenience, this is displayed similarly to the battery level, showing "**remaining** space".

### 1.1.5 Connection Status Indicator

Helps you tell whether you are in good connection**** with DWARF 3.

### 1.1.6 Connect

#### 1.1.6.1 App Connection

Before connecting, it displays "Connect". Click on "Connect" and follow the prompts to connect to DWARF 3. After connecting, it will display **"Live".**

>   * When connected, your mobile devices still support using cellular data / internet access
> 
>   * Some specific mobile phones or cellular enabled tablets may need to "_enable mobile data_ " in their permissions settings or sub settings - _this usually applies to Android devices_
> 
> 

>   * When connected, your devices still support using cellular data or internet access (need to enable mobile data).
> 
> 

#### 1.1.6.2 Quickly disconnect or switch devices

In the **Nearby Devices list** , you can simply tap on another DWARF device to **switch the connection instantly** , without needing to manually disconnect from the current device first.

If you only want to disconnect from the current device, you can tap **Disconnect** to **immediately end the connection** , making it easy to reconnect later or switch to a different usage scenario.

#### 1.1.6.3 Connection Methods Overview

You can connect your mobile device to DWARF in **3 different modes** :

#### 1.1.6.4 Auto Mode (Recommended)

Auto mode automatically detects your current network environment and selects the **most stable connection method** without manual configuration. For most users and situations, this is the **simplest and most reliable option**.

> **Note:** If you experience random or sudden disconnects, Auto Mode may be switching between AP and STA based on **signal strength, DWARF’s position, and your network setup**.
> 
> If this happens repeatedly, you can **manually select either AP or STA mode** in the settings to stabilize the connection.
> 
> Please use the **Support reporting feature** to share your experience with DWARFLAB. This helps the team analyze the devices data and improve connection handling in future updates.

#### 1.1.6.5 STA Mode

DWARF connects to a **home or public Wi-Fi router** , which acts as an intermediary between the device and your phone or tablet.  
This allows your mobile device to **remain connected to the internet** while controlling DWARF, enabling features such as online services, syncing, and uploads.

> **Note:**
> 
>   * Connection stability in STA mode depends on your router’s range, configuration, and Wi-Fi band. If you experience connection issues, verify that your router meets the recommended settings and that required features are enabled.
> 
>   * STA mode allows for a longer control distance, approximately 10 meters. If you're using a LAN-Node (mesh network) setup over a large spatial range, the STA connection might malfunction.
> 
> 

> 
> To fix that, ensure that both DWARF and your mobile/tablet device connect to the same SSID that covers DWARF's sitting location (if using a mesh network, connect to the closest node). Then, when moving to a different SSID's coverage area, manually switch your mobile/tablet device's network in the settings to another preferred SSID, if the naming is different or your nodes are not set to handle auto-negotiation (automaticly connects your DWARF or devices to another node). You may need to research the guide or instructions for the specific model of your home wi-fi device.
> 
>   * For networks that have been previously configured, DWARF will remember the password, so you won't need to re-enter it. Also, remember to turn off STA mode if you take DWARF 3 to a new place without an available WiFi access. You may need to reconfigure your STA mode connections after an application or firmware update.
> 
>   * If you plan on traveling away from your home network and have **STA** manually set, remember to change it to **AP** or **Auto Mode** before you head out on your adventure. When in STA connection mode, tap the “⋮” button on the right side of the DWARF device to reconfigure or update the network connection.
> 
> 

#### 1.1.6.6 AP Mode 

Your phone or tablet connects **directly** to DWARF’s built-in Wi-Fi hotspot. This mode does **not require an internet connection** and is best suited for outdoor use or locations without reliable Wi-Fi access.

> Note: If your device lacks a cellular network (e.g., a Wi-Fi-only tablet), using AP mode will disable internet-dependent features such as **activation, Sky Atlas downloads, firmware updates, and log uploads**. In this case, please switch to STA mode in a Wi-Fi environment to access these features.

#### 1.1.6.7 Near Field Communication (NFC) Connection

1\. Unlock your phone.

2\. Place your phone's **NFC module** under the ring light until the NFC notice prompts.

3\. Tap the**prompt** to open the DWARFLAB App. DWARF 3 will connect to your phone automatically. 

>   * The NFC module on the iPhone is located at the **top** of the device. To initiate the connection, align the**top** of your phone vertically with the **side** of the DWARF and hold it in close for approximately 2 seconds to trigger the connection prompt. If necessary, remove your phone case before attempting NFC connection.
> 
>   * You can check if your phone supports NFC (Near Field Communication) by searching for "**NFC** " in the phone system settings.
> 
>   * NFC connection will build a connection based on your current setting, so it could be either STA or AP.
> 
> 

#### 1.1.6.8 Connect by IP Address  
 

Manual IP connection is designed for advanced or special network situations. Most users can connect to DWARF through the Nearby Devices list and do not need to use this feature.

You may need to connect by IP address when:

  * Your DWARF is connected to a router, but it does not appear in the Nearby Devices list.
  * Automatic discovery is unavailable or unstable because of your local network settings.
  * You already know the IP address of a specific DWARF and want to connect to it directly.

**Before You Start**

Make sure that:

  * Your DWARF is powered on.
  * You know the DWARF device’s IP address.
  * Your phone and DWARF are connected to networks that can reach each other.
  * The IP address is still valid. If DWARF reconnects to a different network, its IP address may change.

> Manual IP connection does not replace network setup. DWARF must remain connected to the network where the IP address is available.

Step 1: Get the DWARF IP Address

You can obtain the DWARF device IP address in either of the following ways:

  * After successfully connecting to DWARF through AP or STA mode, open the device information page in the app and copy the IP address.
  * For a DWARF connected through STA mode, you can usually find it under:
  * **Me > My Devices > IP Address**

#### 1.1.6.8 Connect by IP Address  
 

Manual IP connection is designed for advanced or special network situations. Most users can connect to DWARF through the Nearby Devices list and do not need to use this feature.

You may need to connect by IP address when:

  * Your DWARF is connected to a router, but it does not appear in the Nearby Devices list.
  * Automatic discovery is unavailable or unstable because of your local network settings.
  * You already know the IP address of a specific DWARF and want to connect to it directly.

**Before You Start**

Make sure that:

  * Your DWARF is powered on.
  * You know the DWARF device’s IP address.
  * Your phone and DWARF are connected to networks that can reach each other.
  * The IP address is still valid. If DWARF reconnects to a different network, its IP address may change.

> Manual IP connection does not replace network setup. DWARF must remain connected to the network where the IP address is available.

Step 1: Get the DWARF IP Address

You can obtain the DWARF device IP address in either of the following ways:

  * After successfully connecting to DWARF through AP or STA mode, open the device information page in the app and copy the IP address.
  * For a DWARF connected through STA mode, you can usually find it under:
  * **Me > My Devices > IP Address**

  * If DWARF is connected to your home or local router but cannot be found in the app, log in to the router’s management page and look for DWARF in the connected-device list. Copy its assigned IP address.

Step 2: Connect by IP Address

  1. Open the **Nearby Devices** page in the DWARF App.
  2. Select **Connect by IP Address** or the manual IP entry option.
  3. Enter the DWARF device IP address, for example: `192.168.1.100`.
  4. Tap **Connect**.

  * If DWARF is connected to your home or local router but cannot be found in the app, log in to the router’s management page and look for DWARF in the connected-device list. Copy its assigned IP address.

Step 2: Connect by IP Address

  1. Open the **Nearby Devices** page in the DWARF App.
  2. Select **Connect by IP Address** or the manual IP entry option.
  3. Enter the DWARF device IP address, for example: `192.168.1.100`.
  4. Tap **Connect**.

If the IP address is valid and your phone can reach the device on the local network, DWARF will connect successfully.

If Connection Fails

  * Check that the IP address was entered correctly.
  * Make sure DWARF is powered on and still connected to the network.
  * Confirm that your phone and DWARF can communicate on the same local network.
  * If the device was reconnected to a router, check whether its IP address has changed.

### 1.1.7 Schedule Shooting

Tap here to create your shooting plan, currently limited to deep-sky objects. For detailed instructions, refer to the [**_3.8 Schedule Shooting_**](https://help.dwarflab.com/en/docs/DWARF-3-Smart-Telescope-User-Manual-Part1-App-Interface-Introduction?product=dwarf-3#3-8-schedule-shooting) tutorial.

### 1.1.8 Light Setting

Turning off the DWARF's lights can reduce potential light disruptions while you take Astrophotography.

### 1.1.9 DWARF Assistant

DWARF Assistant is your smart in-app helper. It can help you create tasks, learn about DWARF features, find relevant guides, and answer questions about astronomy and imaging.

For detailed instructions, see [DWARF Assistant](https://help.dwarflab.com/en/docs/DWARF-Assistant).

### Floating-window behavior

After 3 seconds without interaction, the DWARF Assistant floating icon shrinks and becomes semi-transparent to reduce obstruction. Tap, drag, or otherwise interact with the icon to restore its normal state.

## 1.2 Sky Atlas

### 

> **First-time use:**
> 
>   * When opening the Sky Atlas feature for the first time, make sure your mobile or tablet device is **connected to the internet or cellular data first**. Download the catalog database if prompted.
>   * **Device storage requirement:** Your phone or tablet must have **at least _2 GB_ of free storage** to download the Atlas database. If you receive an error, free up space and try again.
>   * **Other settings:** Make sure **Airplane Mode and VPN are turned off** during the download to avoid interruptions.
> 

### 1.2.1 Exit

Tap to return to the homepage.

### 1.2.2 Search Your Target & Shoot

Enter the **Name or Alias** of a celestial in the search box to quickly find the target.

> **Note:** Some name variations or identifiers may not be exact. If you have trouble finding a target, please reference outside sources (via the internet) to find alternate namings.

> **🌍  ****Enter Coordinates** : If a target’s name is not available in the search, you have the ability to manually input the **RA** and **DEC** of the target. (Right Ascension and Declination are coordinates on the sky that correspond to longitude and latitude on Earth) **Tap "+"** and enter the RA and DEC of a celestial to quickly find the target.

> **🌠  ****Tonight** : Recommend the best targets based on your time and location. Click the little camera on the right to track the target, manually set parameters and then start the shooting automatically.

> **📑  Favorites**: Click the "Heart" to add your favorite targets to this list.

> **💻  Dwarflab**: This is the Dwarflab celestial database, which contains many **celestials suitable** for DWARF observation and their **visibility** **status** ; "currently invisible" means that this target is never visible at your location.

> **🌌  Celestial Categories**:
> 
> By type: **Nebulae, Galaxies, Planets, etc.**
> 
> By common catalogs: **Messier, NGC, IC.**

### 1.2.3 Preview Frame (Astro Mosaic)

  In addition to the shooting targets mentioned above, you can now freely compose your astronomical images within the preview frame of the DWARF 3! For detailed information on Astro Mosaic, please refer to**_Section 3.9 Astro Mosaic_.**

> On posing the frame, the **coordinates** at its**center** will be used in later actual capture. These coordinates may not correspond to the original target selected in the Atlas, and it will display as "**Unknown**."

### 1.2.4 Compass

Helps you know the actual direction the phone is pointing at.

Pick up your phone or click the little compass icon, the atlas will enter **auto-follow** mode. Lay the phone **flat** to use as a guide tool. 

### 1.2.5 Sky Atlas Menu & More

You can view various celestials and constellations in the Sky Atlas.

Click on the name of a celestial and swipe upon the pop up page to display its detailed information (type, alias, coordinates, and the suitable filter for imaging it, etc.).

**Grid** : Turn on to display the positioning grid.

**Labels** : Turn on to display the names or labels of celestials.

**Atmosphere** : Turning it on displays the state of celestial bodies under current weather conditions.

**Landscape** : Turn on to display a simulated landscape, making the horizon position clearer.

The updated Sky Atlas comes with a refreshed interface and new tools to help you find targets, plan your framing, and start imaging more easily.

  1. Find a Target：

Tap the **Search** icon to quickly find the celestial object you want to observe.

You can also use **Target Filter** to narrow down targets by observation time, magnitude, altitude, and azimuth. Frequently used filter settings can be saved for quick access later.

Before planning or starting imaging, check the target direction, its classification including Comet, and the current Sky Atlas data shown for that target.

  1. Preview the Field of View：

Use the viewfinder to preview the field of view for different DWARFLAB devices and lenses.

  * **When no device is connected:** Select a DWARFLAB device and switch between the Tele and Wide lenses to preview the corresponding field of view.
  * **When a device is connected:** The viewfinder displays the field of view for the currently connected device.

  1. Astro Mosaic：

Use **Astro Mosaic** to expand the imaging area, making it easier to capture larger celestial objects or wider regions of the sky.

  1. Star Party：

Use **Star Party** to capture the same target together with other users.

For detailed instructions, refer to the [**Star Party**](https://help.dwarflab.com/en/docs/Star-Party?product=dwarf-3) guide.

### 1.2.6 Time

Display the current local time. Clicking on the time allows you to adjust it, and the Atlas will display the celestial objects status based on the set time.

### 1.2.7 Sky Finder

**Sky Finder** shows the celestial targets that can be photographed within the area displayed in the wide-angle viewfinder. You can select a target to view its details or start a One-tap GoTo.

>   * Tap **Sky Finder** to discover shootable celestial targets within the wide-angle live view!
> 
>   * Point your DWARF 3 toward an open area of the sky with visible stars, and tap "OK".
> 
> 

> 
>   * It will take a moment to identify the celestial objects in the wide-angle view.
> 
> 

> 
>   * After a moment, the celestial objects within the wide-angle view—including their names and positions—will be displayed.
> 
> 

> 
> *Please note that manually moving the DWARF 3 will require a re-identification. However, if you use the virtual joystick in the bottom-left corner to move the device, the visible targets will update in real-time.
> 
>   * Tap a target and select the camera icon on the right to start GoTo for that object. DWARF 3 will automatically perform **calibration, positioning, and tracking** all by itself. Sit back and let the telescope do its thing.
> 
> 

### Recognition, obstruction, and recovery

While the App is identifying the sky, you can cancel the recognition. After moving DWARF manually, refresh or run recognition again to update the target results; when you use the virtual joystick, visible targets update in real time.

**Check for obstructions:** Before using One-tap GoTo, check the shooting direction for buildings, trees, and other obstructions. This reminder cannot predict obstructions that may affect a future Scheduled Shooting plan.

If recognition fails, point the device at a clearer area of sky, check that the wide-angle view is unobstructed, and try again.

## 1.3 Explore (PhotonVerse)

### 1.3.1 About PhotonVerse

**PhotonVerse** is the community in the DWARFLAB App. You can browse photos and videos shared by other users, post your own work, and interact with community content.

### 1.3.2 Enter PhotonVerse

Tap **Explore** in the bottom navigation bar. You can browse public content without signing in. Posting, interacting with content, and opening your profile use your current DWARFLAB account, so you do not need to create a separate PhotonVerse account.

### 1.3.3 Browse, Post, and Interact

Browse community photos and videos from the PhotonVerse Home page. Tap **+** to publish a photo, video, text record, or Star Party post.

Open a post to like, save, comment, or share it. To report a post, open its menu, tap **Report** , choose a reason, add details if needed, and tap **Submit Report**.

### 1.3.4 Profile

Tap the profile icon in the upper-right corner to view your profile, posted content, Star Party activity, likes, favorites, and comments. Tap **Edit Profile** to update your profile information.

Use the back button to move through PhotonVerse pages. From the PhotonVerse Home page, press Back again to return to the App Home page.

### 1.3.5 Start a Star Party (Shoot Together)

**Star Party (Shoot Together)** lets you create or join shared CoStack and CoMosaic projects.

**Before you begin** , connect DWARF mini, allow location access, and make sure the target is visible and the device is idle.

  * **CoMosaic** always requires EQ mode.
  * **CoStack** requires EQ mode when a single exposure is longer than 30 seconds. For shorter exposures, follow the recommendation shown in the App.
  * If selected material cannot be uploaded, follow the message shown in the App.

On the project page, use **Copy Coordinates** when needed, claim or give up a task, upload your material, and check its review status. If publishing fails, correct the information and tap **Retry**.

When a project is complete, open its result page to view or download the released files.

## 1.4 Album

The photos in the album are categorized and displayed in chronological order, with the date and time of the photo indicated. For photos taken in different modes, different icons are displayed in the corners.

### 1.4.1 Infinity Lab

In the topmost part of the album, you can find the Infinity Lab. This feature includes**Mega Stack, Stellar Studio, and Pano Weave** — three powerful tools that let you process your captured images in amazing ways. It’s like magic for your photos! For detailed instructions, refer to: **Section** **3.6 Stellar Studio, Section 3.7 Mega Stack,** and**3.5.4 Pano Weave.**

### 1.4.2 Categorization

This is where all album categories are listed. Click to access photo libraries in different modes, including: Photos, Videos, Bursts, Panoramas and Astro photos.

  * Bursts & Panoramas: The Album will only display the first image and the number of shots taken (for burst), but these cannot be downloaded to your phone.

  * Astro Photos: Include all Captured Astro Photos and Mega Stack Photos. For astronomical targets, in addition to the date and time, the target name and other info of the session is also displayed.
  * > Astro sessions generate many individual sub-frames saved inside the telescope, so storage usage can grow quickly (couple gigabytes/GB).

  1. If you notice any issues in the stacked result, **you can manage individual frames — delete unwanted ones and re-stack using Mega Stack.**

> The stacked image generated by MegaStack does not retain individual frames, so single-frame management is not available.

  2. **Tap the Edit button to start post-processing your astronomy image.**

  3. **In the details page of an astronomy photo, you can now view target information, image parameters, file location.**

### 1.4.3 Select / Edit Album

Tap to select photos then you can save or delete photos in batches.

>   * In case of poor network conditions, loading photos might take a few seconds, and videos may also require some time to be refreshed.
>   * When you delete your photos in the **Album** , files in your Dwarf's **storage** are also**wiped**.
> 
>   * Deleting a certain Astro/Panorama/Burst photo will result in deleting **the whole package** under it. As saying, all the single frames of the stacked Astro photo or all panorama puzzles.
> 
> 

### 1.4.4 PhotonVerse

#### 1.4.4.1 About PhotonVerse：

**PhotonVerse** is the community within the DWARFLAB app. Here, you can browse photos and videos shared by other users, post your own work, and interact with the community.

#### 1.4.4.2 Enter PhotonVerse

Tap the **Explore** icon in the bottom navigation bar to enter the community.

PhotonVerse uses your current app account, so there is no need to register or sign in separately.

#### 1.4.4.3 Browse, Post, and Interact

In PhotonVerse, you can browse photos and videos shared by other users and post your own content.

You can also interact with community posts by:

  * Liking
  * Saving
  * Commenting
  * Sharing
  * Reporting

#### 1.4.4.4 Profile

Go to your profile to view your personal information and the content you have posted.

## 1.5 Settings

### 1.5.1 Log In

Tap "Log In" to create your account. Many upcoming interesting features will require an account (Stellar Studio, Panorama, etc). You can register and log in using your phone number or email. Feel free to update your profile picture, nickname, and other personal information.

#### 1.5.1.1 Password Requirements / Reset Password

Passwords must be between**8–64** characters. They can include letters and numbers, but **no spaces or special characters**.

To reset your login password, at the Login screen, enter your email or phone number assigned to the account (⚠️If you have already logged on, **you need to log out first**), on the next screen, select “Reset Password” located under the password entry block. Follow the prompts to reset your password.

> Please note that the account systems for the beta and official versions of the app are not connected. **You will need to register a new account when joining the test program and using the beta application version.**

### 1.5.1.2 Human Verification During Registration

During registration, complete the on-screen human verification when prompted after requesting a verification code. The verification code is sent only after verification succeeds; then return to the registration flow and enter the code to continue.

### 1.5.2 My Device

1\. **Device** : Displays your DWARF's model (Yes there will be more).

2\. **Mac Address**

3\. **Storage** : Displayed as used/total memory, following standard convention.

> The system is equipped with 128GB eMMC storage.
> 
> Please note: the operating system and essential files for the DWARF 3 will utilize a portion of this storage space, resulting in slightly less available total storage for use.

4.**Image Calibration**

Dark frames used to reduce noise in astronomical images for both tele and wide imaging are listed here. You can add, delete, or manage dark frames from this interface.

For more details about **Dark Frames** , please refer to section****[**3.2.3 - Dark Frames & Quick Apply**](https://help.dwarflab.com/en/docs/DWARF-3-Smart-Telescope-User-Manual-Part1-App-Interface-Introduction?product=dwarf-3#3-2-3-dark-frames-quick-apply), in the tutorial.

Currently, only**dark frame management** is available for management. Other types of calibration frames, such as **flat frames** and **bias frames** , are under development and will be added in future updates.

> **💻  BIAS **and **FLAT** frames
> 
>   * Bias frames are used to correct sensor readout noise. Flat frames are used to correct uneven illumination and dust shadows (dust motes) in the optical path.
> 
>   * DWARF 3 comes pre-loaded with BIAS and Flat frames calibrated for each individual device. Since the DWARF 3 uses a fixed optical system, factory provided Flat data remains valid over time. There is no need for users to capture new BIAS frames manually in common cases.
> 
>   * For those who have specific post-processing work flows that may require the use of those files, you can always use the calibration files (CALI_FRAME) stored in the DWARF 3. Please reference the ["How to View and Edit Files in DWARF 3"](https://help.dwarflab.com/en/docs/How-to-View-and-Obtain-the-Files-on-DWARF-3?fbclid=IwY2xjawNYPnVleHRuA2FlbQIxMABicmlkETF1dFppWWRHTU4zTEtGemtyAR6dM-ePiKtaMgAK9R_hfSn1WWE3oxu2YU9HN8YNlYBqshWcwNfMq0H9slY1xg_aem_iG9RU6nV32K8LLLqTXBoLA#2.1.1_CALI_FRAME) document on where to find them.
> 
> 

5\. **Device Name** : Here get your DWARF a great new name. (Default name is the last six digits of the Mac number showing on the bottom base). I call mine Webb. Changes take effect after a restart.

6\. **Device Password** : Change the password here; changes take effect after a restart. The default password is DWARF_12345678.

7.**Reset Device Name and Password** : In case you forget your password, reset it at any time. After confirming the reset, press the power button briefly within 30 seconds—just once! The reset takes effect after a restart.

> **💻  Note：**Everytime you change the name of your DWARF, an update with the NFC information is required, you need to tell the NFC connector what name it should submit when pairing with your phone.

8\. **NFC Update**

Here is where you can update your NFC info.

9\. **Activation Status** :

> **💻  Activation Time**: Date of activation
> 
> **Warranty Status** : If you are in the warranty period, it'll take a few seconds for the status to show up after entering this page.
> 
> **Official Warranty Period** : The expiration date of your warranty time.

10\. **IP Address** : displays the devices current IP address. It will update when connected to a wireless network when STA mode is configured. Check this when you require an IP for FTP access, or other functions that specifically need it.

11\. **Firmware Version** : The firmware version of DWARF 3. What is Firmware you might ask, Firmware is the built-in system of the DWARF Telescope, requiring regular updates like your app, adding new features.

12\. **Firmware Upgrade** : Access the firmware upgrade process here. Follow the prompts to complete the upgrade. 

When your DWARF device is connected to the internet, a red dot will indicate if an update is needed. Follow the guided prompts to completed firmware updates when required. Remember to REBOOT your device upon completion. There may be a mandatory update notification displayed when the DWARFLAB application has a specific feature of functional update. Mandatory updates ensure the user is reminded to download the required firmware or they may find specific features will not work as intended until the update is applied.

> **🔭  Firmware Update Note: **
> 
>   * You can not "re-install" a firmware update
> 
>   * You can not roll back an update to a previous firmware
> 
>   * If you are having problems upgrading the firmware, or problems after the firmware update is applied, kindly contact our team via support@dwarflab.com
> 
> 

13\. **Reboot** : Restart DWARF 3.

14\. **Shut Down** : Allows you to remotely shut down DWARF 3 when it is not at hand. The shutdown mode will **rotate the cylinder (lens) down to a closed position**. It will not rotate the base back to a default position. You can manually move the base on your own.

### 1.5.3 Connection Settings

  1. **Enable 2.4 GHz** : Normally, DWARF 3 defaults to send out a 5 GHz band signal. This setting allows DWARF 3 to emit a 2.4 GHz band signal, supporting connections to tablets or mobile devices that may not have a 5 GHz band available.

> _2.4GHz transmission will cause certain lag due to lower transmission speeds and possible interference from other electronic or household devices in your home._

  2. **Wi-Fi Compatible Mode** : Tailored for users in special regions where Bluetooth can't activate DWARF 3's hotspot, this mode can be a solution. For most users with free access to the Internet, skip this part.

  3. **Region** : To comply with network communication standards, please select your current locating country/region.

**Regional Network Restrictions:** Wireless network settings may vary by country or region.

  * **Israel:** Due to local regulations, the device cannot use the 5 GHz band. **2.4 GHz is always enabled and cannot be turned off.**
  * **Japan:**  ******2.4 GHz is enabled by default.** If you turn off 2.4 GHz, confirm that the connection remains suitable for your current outdoor environment before use. Re-enable 2.4 GHz if the App displays the regional outdoor-use warning or if the connection is unstable.

### 1.5.4 Location

In **Location** , you can manage the location information used by the app and choose whether to save location information with your photos.

This page includes two main settings:

  * **Set Location Automatically** : Automatically detects your current location. Turn it off to manually enter latitude and longitude.
  * **Location Tag** : Determines whether the currently set location is saved with JPEG photos captured using DWARF.

> **🌍  Location Note:** Correct coordinates are essential for accurate calibration and object locating with the DWARF 3. If you’re traveling to remote locations without mobile service—or using a tablet that can’t get a GPS fix—plan ahead. Locate your observing site on a map in advance and record the latitude and longitude. Having this information ready will save time and prevent headaches during setup and calibration.

#### 1.5.4.1 Set Location Automatically

Turn on **Set Location Automatically** to let the app automatically detect your current location and use it for features that require location information.

This is a shared location setting across the app. If automatic location is turned on or off from another feature that uses the same setting, the status here will update accordingly.

For astronomy photos, you can view the location used for the photo by going to:

**Album > Open an astronomy photo > Photo Details**

#### 1.5.4.2 Set Location Manually

Turn off **Set Location Automatically** to manually enter the latitude and longitude.

This is useful when you want to specify a different observing location or when your device cannot accurately determine your current location. Once set, features in the app that require location information will use the manually entered location.

The new location will also be used for astronomy photos captured afterward. You can check the location in:

**Album > Astronomy Photo > Photo Details**

For example, if you are currently in Wuhan but manually change the coordinates to a location in Henan, astronomy photos captured afterward will show the location in Henan.

> How can I get the latitude and longitude?

> If you do not know the coordinates of your observing location, you can look them up using Google Maps or another map service.

> Latitude and longitude are typically entered in decimal degrees, with **latitude first and longitude second**.

#### 1.5.4.3 Location Tag

**Location Tag** determines whether the currently set location information is saved with JPEG photos captured using DWARF.

When enabled, the location information is saved with the photo and can be viewed in apps or on devices that support photo location metadata.

For example, after saving a photo to your phone, you can view its location in the photo details in your system gallery.

When **Location Tag** is turned off, location information will not be saved with the JPEG photo.

#### 1.5.4.4 Which Location Is Saved with Location Tag?

**Location Tag saves the location currently set in Location.**

  * When **Set Location Automatically** is enabled, the automatically detected location is saved.
  * When automatic location is turned off and the latitude and longitude are entered manually, the manually set location is saved instead.

For example, even if you are physically in Wuhan, if you manually set the location to Henan before capturing the photo, the saved location information will show Henan when **Location Tag** is enabled.

> **Tip:** Accurate location information helps with calibration and target locating. If you are traveling to an area where location services may be unavailable or inaccurate, we recommend checking the latitude and longitude of your observing site in advance.

### 1.5.5 General

1\. **Language** : Currently supports 10 languages, as shown in the image.

2.**Temperature Unit:** Switch between Celsius and Fahrenheit.

3.**Appearance** : Choose between Dark/Light mode or follow system settings.

### 1.5.6 Support

In this part, you can upload the log for DWARF 3 if there is any problem.

**Log Upload** : DWARFLAB app automatically records DWARF 3 logs while you are using it. Upload the log and contact our support team when needed. Or contact our official after-sales support email at [Support@DWARFLAB.com](mailto:Support@DWARFLAB.com) for expert advice.

1.**Problem Type** : Select the type of issue encountered.

2\. **Log** : Logs are overwritten after reaching 10MB. Report errors promptly if you can.

3\. **Email Address** : Provide your email for contact.

4\. **Date of Problem** : Select the date when the issue occurred so that we locate the problem quicker.

5\. **Description** : Provide as detailed a description of the problem to help us better understand and solve it!

6\. **Media** : Uploading screenshots or screen recordings is a very helpful and necessary step, as it greatly increases the chance of reproducing the issue you're experiencing for us.

> You can**leave this page** at any time to take a screenshot/recording, then return. The system will record your input and provide a recovery option.

7\. **Submit** : Submit and we will contact you within the next 48 hours. 

> 💻  If you encounter connection issues, you can also upload logs.
> 
>   * After clicking "**Upload Anyway** ", fill in the required information as usual. (When connected to the DWARF 3, logs from both the telescope and the mobile app will be uploaded. If not connected, only logs from the app will be uploaded. )
> 
>   * Submitting logs does not require disconnecting DWARF 3 from the phone; but a mobile network or internet connection is needed.
> 
> 

### 1.5.7 Clear Cache 

**Clear Cache** : Allows you to clear the album thumbnail cache, Pano Weave upload cache (using mobile data) and half-downloaded firmware (useful for rescuing you from stuck mid-upgrade).

### 1.5.8 About

1\. **Terms of Service** : View the service agreement.

2\. **Privacy Policy** : View the privacy policy.

3\. **Open Source Software Statement**

4\. **App Update** : View the app version.

# 2\. Shooting Interface Introduction

## 2.1 Exit

Click to exit the shooting interface and return to the homepage.

## 2.2 Dual Lenses Switch

The dual-lens system helps in quickly locating targets. Please read the following tutorial with devotion.

**Open/Close Dual View** : Click to open/close the dual views.

**Switch View** : Click the small rectangle or tap the **T/W** button on the right to switch between views.

**View Indication** : The telephoto view shows the content within the green frame in the wide-angle view.

> 💻  Double-clicking on the telephoto view enables auto-focus. Wide-angle is a fixed focal length. The Auto-Focus function does not apply, nor can you manually focus on the optic.

**Dual Lenses Locating** : Switch to the wide-angle view, then double-tap on the screen to move the green frame indicator (which represents the telephoto view) and easily put your target into the tele lens — for example, birds in the backyard or people walking on the street — and then quickly switch to the telephoto view for close-up observation.

>   * The dual-lens system may occasionally become out of sync when switching between targets at different distances. Performing auto-focus will restore alignment. It’s recommended to run auto-focus in a bright environment while aiming at a distant object for the best results.
> 
> You cannot use double-click to auto-focus in Astro Mode, as we want to avoid accidentally disrupting the perfect focus you’ve carefully achieved.
> 
> 

## 2.3 Key Features

This button serves as a key feature button in each mode. For example, in **General Mode** , tapping this button activates **object tracking**.

In **Deep Sky Mode** , you can tap here to access features such as **EQ settings** , **dark frame management** , and **curve color adjustment**. For detailed information, please refer to the **_Section 3.2_** __**_Deep Sky Mode_** later in this manual.

## 2.4 Navigation Control Panel

Method 1：

Move the joystick to navigate the lenses. The farther the virtual **ball moves from the center** , the faster the movement speed as indicated by the coloring scheme.

Method 2：

Use the **speed dial** to control the device’s rotation speed. When operated, the device will rotate at the set speed. A higher value makes the device rotate faster, while a lower value makes it rotate more slowly.

You can also use the surrounding **arrow buttons** to control the rotation direction. **Press and hold** an arrow button to rotate the device continuously at the speed set on the speed dial; **tap** an arrow button for precise fine adjustments.

> **🔭  Navigation Tips:**
> 
> You can quickly and precisely locate your target by combining the following three methods:
> 
>   * Manually rotate the lenses to roughly align with the target.
> 
>   * Use dual-lenses (picture in picture) locating to align the target.
> 
>   * Adjust the lens position finely with the joystick/arrow.
> 
> 

### 2.4.1 Joystick Control

Two joystick control modes are available. Choose the one that best suits your control preference. For detailed instructions on both control modes, refer to [**Joystick Control**.](https://help.dwarflab.com/en/docs/Joystick-Control)

## 2.5 Album

Quick visit for photos.

## 2.6 Full Screen (Hide All Controls)

**Tap** this button or**long press the screen to hide** all on-screen controls and enjoy an **immersive viewing experience**. Press and hold to **restore** the controls. 

## 2.7 Key Parameter Bar

This bar area displays key imaging parameters such as **exposure** , **gain** , and **filter** , which affect the final image the most.

## 2.8  Capture Modes & Shooting Settings

You can switch between different capture modes based on your shooting needs. Four modes are available: **Photo, Burst, Video, and Time Lapse**. Each mode provides different shooting settings.

  1. Photo

Use **Photo** mode to capture a single still image.

You can select the available **resolution** for the telephoto and wide-angle lenses.

  2. Burst

Use **Burst** mode to capture multiple photos in succession.

You can adjust:

     * **Interval:** Sets the time between each shot.
     * **Count:** Sets the total number of photos to capture.
  3. Video

Use **Video** mode to record continuous video.

You can adjust:

     * **Resolution:** Sets the video resolution.
     * **Frame Rate:** Sets the number of frames recorded per second.
  4. Time Lapse

Use **Time Lapse** mode to capture images at set intervals and create a time-lapse video.

You can adjust:

     * **Shooting Duration:** Sets how long the time-lapse capture will continue.
     * **Interval:** Sets the time between each capture.

## 2.9 Shooting Mode Switching

## 2.10 Focus

Tap 'Focus-**AF** ' for auto-focus. **Long press** or tap **+/-** to adjust the focus. The focus scale value helps you better confirm the appropriate focal point.

Focusing on targets at a distance of**5 meters** or more. Focusing on targets less than this may result in autofocus failure. 

> The Auto button turns green during focusing and reverts to white once focus is achieved.

> **Focus Feature Update (2025.12.30) Continuous Autofocus for Daytime Scenes (AF-C)**

We’ve added **Continuous Autofocus (AF-C)** for daytime use. When enabled, you no longer need to manually focus when shooting your target or refocus while viewing subjects at different distances. The telephoto lens will **automatically maintain image sharpness continuously while the device is moving** , making daytime observation much smoother and more convenient.

***Notes:**

  * This feature is available **only in General Mode** , **Panorama** and **Auto Capture** modes. It is **not supported at night**. **In Panorama, AF-C works only before shooting starts.** Focus remains locked during capture.

  * During autofocus, you may hear a **grinding-like focusing sound**. This is the normal sound of the motor operating and **does not indicate a malfunction**.

## 2.11 Tele/Wide Switch

Tap this button to switch between the **telephoto** and **wide-angle** lenses as the **main view**.

The lens you intend to use for shooting must be set as the **main view** before capturing photos or videos. 

## 2.12 Shoot

The shooting button, tap to start shooting.

## 2.13 Parameter Settings

Here, you can freely adjust the **shooting parameters** for both the **wide-angle** and **telephoto** lenses.

### 2.13.1 Shooting Parameter Settings

You can adjust the shooting parameters such as Filter/Shutter/Gain.

**Filter** : DWARF 3 has 3 built-in filters. See details in** _Section 3.2 Deep Sky Mode_.**

**Exposure/Shutter** : Adjust shutter time. Automatic shutter setting is always recommended for daytime. More to be introduced for astrophotography exposure in the next section tutorial. 

_For Astrophotography, set shutter longer than 15s._

**Gain** : Adjust the gain setting. Keep between 0-30 for daytime normally. More to be introduced for astrophotography gain in the next section tutorial. 

_For Astrophotography, set gain to 60 or above._

**White Balance** : Usually set to Auto. Adjust to warmer temp. when you feel like getting a yellow or orange sun/moon. 

**Other Settings** : Feel free to experiment with different parameter adjustments. 

> **🔭  Important Note on Parameters:**
> 
>   * When switching modes, you may notice that the **exposure** and **gain** values change automatically based on ambient brightness. At all other times, these parameters will remain fixed to your manual settings and will not change unless you adjust them yourself.
> 
>   * To ensure the best imaging results, when shooting **deep-sky objects (DSOs)** or **the Sun and Moon** , if you haven’t manually set your parameters, pressing the **shoot** button will automatically switch the **exposure** and **gain** from _AE (auto exposure)_ to a set of **recommended fixed values**. (Because during astrophotography, parameters are not expected to change with environmental variations, keeping them within a fixed range ensures image stability and consistent capture quality.)
> 
> 

### 2.13.2 Image Format Settings

Here, you can set the**format** of your works (JPG/PNG/FITS/TIFF etc.) and adjust **other related settings**.

## 2.14 Information Bar

### 2.14.1 Temperature

Displays the real-time temperature of the **telephoto camera inside the camera module**.

> This data assists in assessing whether the temperature of your existing dark frames matches the current conditions. If there's a **significant discrepancy (±8℃)** , **retaking dark frames may improve your results**. For detailed information, please refer to **_Section 3.2 Deep Sky Mode_**.

> **Note:** The temperature shown here is the real-time temperature of the telephoto camera, not the battery NTC temperature, so it cannot be used to determine whether the shutdown threshold has been reached. The telephoto camera and the battery NTC sensor are located in different parts of the device, and there is no fixed temperature difference between their readings. If the battery NTC temperature exceeds **65°C (149°F)** , the device will automatically shut down for protection. If abnormal overheating occurs, please provide device logs for further diagnosis.

### 2.14.2 Battery & Storage

**Storage** **&** **Battery** Indicates the remaining memory space & battery level of DWARF.

### 2.14.3 Time

Display the current time.

## 2.15 Capture Continuity and Interrupted-Session Results

  1. **Capture Continues After Leaving the Shooting Screen**

Once a shooting task has started, DWARF will continue the task even if you leave the shooting screen or the app disconnects from the device.

You can return to the shooting screen or reconnect to the device later to check the current shooting status.

  1. **Results Are Preserved If Shooting Is Interrupted**

If a shooting task is stopped early or interrupted unexpectedly, any usable results already generated will still be preserved and displayed in **Album**.

For example, if a session is set to capture 300 frames but stops after 150 frames, any valid stacked result generated from those captured frames will still be saved to Album.

  1. **Captured Frames and Stacked Frames May Be Different**

Not every captured frame is included in the final stack. During stacking, frames that are overexposed or do not meet the required image quality may be excluded.

Therefore, the number of stacked frames may be lower than the total number of captured frames, even when the shooting task is completed normally.

> **For example, if 329 frames are captured and 312 are ultimately stacked, this can still be a normally completed imaging result.**

  1. **When No Valid Stacked Result Is Generated**

If frames have been captured but none are included in a valid stack, **Album** will still preserve one captured image, displayed as **Stacked: 1**.

If the target was not tracked before shooting, the result will also be saved in Album as a single-frame result and displayed as **Stacked: 1**.

# 3\. Instruction for Different Modes

DWARF 3 offers **five shooting modes** , allowing you to choose freely based on your desired target. The following sections provide an introduction to each shooting mode.

## 3.1 General Mode (Free)

As an astronomical telescope, **DWARF 3** also offers exceptional **landscape photography** capabilities.

The **General Mode** is designed specifically for **daytime photography** , allowing you to choose either the **telephoto** or **wide-angle** lens for shooting.

Wide camera: suitable for wide scenery, sunrise or sunset views Tele Camera: designed for **close-up and detailed observations** , such as **distant mountains, birds, or wildlife**.

Each lens supports four shooting options — **photo** , **video** , **burst** , and **time-lapse**.

This mode also features a unique **object tracking** function.

By freely switching between the two, DWARF 3 allows you to capture everything from vast landscapes to tiny, faraway details with ease.

Below are some example use scenarios. 

### **3.1.1 Bird Observation**

Use the **telephoto lens** to observe birds in detail — their feathers, movements, and behavior.

The **object tracking** feature keeps them center and precisely in focus all the time, allowing you to follow their motion smoothly and effortlessly. 

**Steps**

  1. **Point the lens toward the direction of the bird.**

  2. Make sure the bird is visible in either the wide-angle or telephoto view.

  3. **Tap “Target Tracking Button” on the left side to enter tracking mode.  **

4.**Draw a box around the bird in the wide-angle or telephoto view.  **

  5. DWARF 3 will start synchronized tracking across both lenses automatically.

  6. Use the function panel on the right to fine-tune focus, exposure, or gain as desired.

  7. **DWARF 3 automatically maintains (follow) focus while the bird moves (AF-C Enabled).**

> _*If focus becomes unclear during movement, try tapping Auto Focus at several distances to help DWARF 3 learn and refine focus accuracy._

  8. **Choose your preferred lens to capture photos or videos.**

  9. For example, to record detailed bird footage, set the telephoto lens as the main view, switch to **Video Mode** , select your resolution and frame rate (e.g., **4K 30 FPS**), and start recording.

  10. **Try tracking other moving subjects.** The same method works perfectly for **airplanes, rockets, athletes, boats, or even your pets** — give it a try! 

### 3.1.2 Wide View Time-Lapse

Use the **wide-angle lens** to capture the ever-changing clouds across the sky, from drifting patterns to stunning fiery sunsets.

**Steps**

  1. **Point the lens toward the sky.** Make sure the wide-angle view covers the cloudscape you want to capture.

  2. **Tap “W” to set the wide-angle lens as the main view.** This ensures the camera records using the wide-angle perspective.

  3. **Adjust image settings such as tone and saturation to your preference.** Fine-tuning these parameters helps bring out the color and texture of the clouds.

  4. **Open the settings panel to configure the time-lapse options.** Set the **shooting interval** , **total duration** , and **resolution** — the final video length will be displayed at the top of the screen. 

**Recommended settings for different scenarios:**

  * **Clouds** : 2-5 second intervals for capturing dynamic cloud movements, aiming for a 20-30 minute duration.

  * **City Traffic** : 1-3 second intervals to capture the hustle of city life, ideally for about an hour during peak times.

  * **Blooming Flowers(Tele Photo)** : Longer intervals, like 1 minute, for slower processes such as flowers blooming, extending over several hours or days.

> When you switch the app to the background or disconnect, the shooting process will still continue. Note that there's a brief delay in saving photos after hitting stop on taking the time-lapse video. So it might take some time for the photos to show up in the album.

## 3.2 Deep Sky Mode

The **Deep Sky Mode** is designed for capturing faint celestial objects such as galaxies, nebulae, and star clusters. DWARF 3 automatically aligns, tracks, and stacks multiple long-exposure images to reveal details invisible to the naked eye, allowing you to explore the deep universe with ease.

When entering **Deep Sky Mode** , you’ll first be prompted to select a target from the **Star Atlas** or the **Sky Finder for a quick stargazing**.

Or **skip this step** to explore and get familiar with the main shooting interface first.

### **3.2.1 Deep Sky Photography (Astro Imaging Walkthrough)**

Let’s take Claire’s first deep-sky shooting experience as an example to learn how to capture a deep sky target using the **DWARF 3** in **Deep Sky Mode**.

**Goal:** Capture a deep sky target with **DWARF 3.**

**Preparation:** DWARF 3 and a smartphone (or tablet)

#### **3.2.1.1 Steps:**

##### **3.2.1.1.1 Setup DWARF (Alt-Az)**

  * On a clear, cloudless night, **power on the DWARF 3** and connect it to your phone.

  * **Place DWARF 3 on a stable, level surface** , such as a flat piece of ground or a tripod.

  * **Look up at the sky** and find an area where stars are visible to the naked eye. Rotate DWARF 3 so that the **lenses** face that direction so there are enough stars for later calibration.

> You may just see all black at first for the shutter is too short, stars will show up later.

##### **3.2.1.1.2 Select A Target**

Now the setup is complete, enter Deep Sky Mode to begin!

  * In this mode, **first select your target.** Here are**2 ways** to select your target:

**Option 1: Sky Finder**

>     * Tap **Sky Finder** to discover shootable celestial targets within the wide-angle live view!
> 
>     * Point your DWARF 3 toward an open area of the sky with visible stars, and tap "OK".
> 
>     * It will take a moment to identify the celestial objects in the wide-angle view.
> 
>     * After a moment, the celestial objects within the wide-angle view—including their names and positions—will be displayed.
> 
> *Please note that manually moving the DWARF 3 will require a re-identification. However, if you use the virtual joystick in the bottom-left corner to move the device, the visible targets will update in real-time.
> 
>     * Tap a target and select the camera icon on the right to start GoTo for that object. DWARF 3 will automatically perform **calibration, positioning, and tracking** all by itself. Sit back and let the telescope do its thing.

**Option 2: Sky Atlas**

>     * Tap the **Star Atlas** , then open **Search**. You’ll see a list of celestial objects available for imaging. Since our goal tonight is Lagoon, simply choose **Lagoon** from the list.
>     * Tap the **small camera icon** on the right. DWARF 3 will automatically perform calibration, positioning, and tracking all by itself. Sit back and let the telescope do its thing.

##### **3.2.1.1.3 Adjusting Parameters**

  * Once DWARF 3 has locked on to the target, it’s time to adjust the parameters for this session. Tap **Parameters** and open the **Telephoto Lens** settings.

  * You’ll notice that **Auto Parameters** **③** are enabled, which means the system has already optimized exposure, gain, filter, and stacking numbers for you. It even estimates a total duration of **about 2 hours**. Perfect, no need to worry about all those options!

  * ##### **3.2.1.1.4 GoTo, Capture & Process**

    * **Tap “Shoot”!** The **imaging and stacking** process begins automatically.

  * Use **two fingers to zoom in** and explore more details. Tap the **Hide Controls** button or **press and hold the screen** for an immersive stargazing experience.

  * You can safely **close the app or walk away during the imaging,** DWARF 3 will complete the session on its own.

  * After several stacked frames, you may think the result looks great enough. **Press and hold to stop the session.**

  * A message will appear inviting you to begin **post-processing**. Tap it to continue. 

  * Upload your stacked image, select **Auto** , and wait for processing. Wow — the result looks amazing!

  * Select **Watermark** , add the name, and share This masterpiece with friends!

#### **3.2.1.2 Footnotes for (Alt-Az) Astro Imaging**

**1\. Calibration**

**Calibration is required** before astrophotography can start with your DWARF device. During this process, DWARF 3 captures multiple images of the sky and analyzes star patterns. These are matched against the internal star catalog to determine the telescope’s orientation and position, enabling accurate target alignment for subsequent observations.

  * Ensure the telephoto lens has a clear, unobstructed view of the sky during calibration. Any physical obstructions or thick cloud cover can cause calibration to fail. Always set up the telescope under a clear sky with visible stars before starting the imaging process.

  * If at any point you need to manually re-do your calibration, select 1. **Parameters > 2\. Settings > 3\. Calibration > 4\. **press the **"Calibration"** button. Your DWARF device will start the calibration process and re-attempt to plate solve. Use this function for Alt/Az setups.

**2\. One-tap GoTo**

The **One-tap GoTo** function makes astrophotography effortless. With just a single tap, DWARF 3 completes a series of traditionally complex steps, creating a true **smart astrophotography experience**. The process includes:

• **Auto Focus** — The telescope automatically fine-tunes the lens to make stars as **small and sharp** as possible, locking focus at the optimal point.

• **Calibration** — DWARF 3 captures sky images, recognizes **star patterns** , and matches them with its **built-in star atlas** to determine its direction and attitude.

• **GoTo Target** — After you select a celestial target from the **Sky Atlas** , DWARF 3 calculates the path and **automatically slews to the object’s position**. Thanks to calibration, it can point with high precision without manual correction.

• **Tracking** — Once the target is centered, DWARF 3 automatically **locks and tracks** it, continuously compensating for **Earth’s rotation** so the object stays in frame during **long-exposure stacking**.

**3\. Auto Parameters**

For first-time users, DWARF 3 provides **Auto Parameters** that automatically set the **filter, shutter speed, gain, and number of frames**.

In **Auto Mode** , the maximum exposure time is **15 seconds**.

If you need a longer exposure, switch to **Manual Mode** for full control of the parameters. **(See details in section 3.2.2 “Going for Advanced Deep Sky Session.”)**

**4\. Long Exposure & Stacking**

Objects like nebulae and galaxies are extremely faint. To capture them, DWARF 3 combines **long exposure** and **multi-frame stacking** to enhance signal strength.

• **Long Exposure – collecting photons**

During long exposure, the image sensor continually gathers photons from the target. The longer the exposure, the more light is collected, revealing **nebulae and faint structures**.

• **Stacking – enhancing signal, reducing noise**

When multiple frames are stacked, **consistent signal is amplified** while **random noise is averaged out** , resulting in a brighter, cleaner, and more detailed image.

**5\. Stellar Studio Post-processing**

With **DWARFLAB’s Stellar Studio** , you can easily perform **post-processing** on your phone. For detailed instructions, see section **3.6** **Stellar Studio**.

### **3.2.2 Going for Advanced Deep Sky Session**

Now that Claire’s first session went smoothly, let’s see how the experienced astrophotographer, **Sue** , approaches her observation.

**Goal:** Complete a deep-sky imaging session

**Preparation:** DWARF 3, smartphone (or tablet), tripod (for EQ set up, optional), solar filter (for shooting darks; optional), power bank (for long term sessions, optional)

#### **3.2.2.1 Steps:**

##### **3.2.2.1.1 Setup DWARF (EQ)**

  * As a seasoned user, **Sue sets up her DWARF 3 on a tripod** under a sky with plenty of visible stars. She powers it on, connects it to her phone, and enters **Deep Sky Mode**.
  * Then she taps **EQ** on the left panel and, following the on-screen guide and animation, focus first, adjusts the mount & the scope until **the alignment** is properly configured.

##### **3.2.2.1.2 Set Target & Parameters**

  * Then she opens the **Sky Finder** or **Star Atlas** to browse potential targets for the night. Targets with an **altitude above 30°** are ideal. She selects her target — let’s call it _Target X_. In Star Atlas, she notes that the **recommended filter** is _Filter Duo-Band_. She keeps that in mind for later when setting parameters. Then she taps the **small camera icon** to start GoTo.

  * DWARF 3 quickly calculates and locks on to _Target X_.

  * On tracking X, Sue notices the stars look slightly soft, so she taps the **Focus** button to run **Auto Focus** again. After a few fine adjustments, the stars shrink to perfect points.

  * She plans a **60-second long-exposure session** **③** , so she turns off **Auto Parameters** , to perform **Manual Settings** **④** , chooses the recommended Duo-Band _**Filter**_ , sets **Exposure/Shutter = 60 s** , **Gain = 60** , and **200 frames** — a solid configuration for deep-sky imaging.

  * Then in the**Settings** (top-right corner of the Parameters panel), she reviews the details of this session:

  1. **Subframe Format:** FITS 

  2. **Display:** Stacked Image

  3. **Mandatory Calibration:** On

  4. **Update Focus Point:** (not needed this time)

##### **3.2.2.1.3 Take Astro Darks**

  * Returning to the Parameter setting panel, she taps **Quick Apply**  and finds that no dark frame matches her chosen parameters, so she’ll need to take a new set later。

  * Everything’s ready. Sue taps **Shoot** , as expected, a prompt appears asking her to **capture a dark frame**  first. Following the instructions, she attaches the filter, turns off nearby lights, and keeps the telescope completely still.

  * The process finishes quickly. She removes the filter, hit the following "ok" button, and the scope just resumes to perform the previous shooting automatically, no need to tap shoot again.

##### **3.2.2.1.4 Processing Image**

While he actual imaging & stacking going on, Sue adjusts the **curve⑪** to refine brightness and raise clearness.

  * Once stacking is complete, she proceeds to **post-processing in Stellar Studio.**

##### **3.2.2.1.5 Take Astro Mosaic**

Then Sue decides to capture another object, this time a with a larger view, so she returns to the **Star Atlas** and selects a new target. 

  * This time, she attempts a **Veil Nebula mosaic**. She searches for the Veil Nebula, opens the preview frame and adjusts its size & position. 

> Due to framing adjustments, the final GoTo position may sometimes point to another target or unnamed object near your selected celestial target, which might be displayed as **“Unknown.”**

  * She tunes parameters in the settings panel and taps **Shoot** to begin. 

  * During mosaic imaging, she notices **the view will automatically switches** among segments.

  * When complete, she remembers that **mosaic images must be stitched in Stellar Studio** to form the final picture. 

  * The result looks fantastic, detailed and clean. She shares her masterpiece proudly.

  * Her 200 friends react with likes and chees, what a wonderful night.

#### **3.2.2.2 Footnotes for (EQ Mode) Advanced Session**

**1\. EQ Mode**

**EQ Mode - (Equatorial Mode)** is a special tracking setup that lets the DWARF 3 tilt the whole mount so its rotation axis is aligned with Earth’s axis, neutralizing the effect of Earth's rotation when tracking the target, ensuring stable tracking during long shutter time reducing field rotation on your stacked image.

Follow the in-App instructions to achieve perfect polar alignment! [**Here** ](https://www.youtube.com/watch?v=Zo2xJSXrm_I)we also prepared a detailed **video tutorial** for EQ setup.

Once you’ve completed polar alignment, an **EQ icon** will appear on the screen. 

**Notes:**

>   * We recommend setting your scope in EQ mode when you intend to set the exposure to 15 seconds and above. _A recent update has now made it mandatory to be in EQ mode for anything 30 seconds and higher_.
> 
>   * Astro mosaic imaging (provides a **larger field of view / FOV)** also requires setting the **EQ mode**.
> 
>   * DWARF 3 does not require you to "see" **Polaris** (Northern Hemisphere) or **Sigma Octantis** (Southern Hemisphere) for EQ (polar alignment) The key is the **axis aligning** , not **target aiming**. So if you don't see it, no worries.
> 
> 

 **2\. Focus**

In astrophotography, achieving proper **focus** ensures sharp star points and crisp images, effectively avoiding issues such as blur, halos, distorted or elongated stars, and loss of detail caused by misfocus. **DWARF 3** features an intuitive **Focus Panel** , allowing users to easily perform precise **manual or automatic focusing**.

• **Focus Panel**

When you open the focus interface, the screen displays various focusing options and a **focus value** that represents the current lens position. You can fine-tune the focus by tapping the **“+” or “–” buttons**. DWARF 3 displays the sharpness of star points in real time to help you judge accuracy. When the stars appear **smallest and brightest** , the focus is correct. 

> A useful note for astrophotography: the **focal point for deep-sky objects is usually fixed**. The **Infinity Focus** represents this standard focus position for night-sky imaging. DWARF 3 provides a one-tap **“Infinity”** button to quickly return the lens to its preset starlight focus range. 
> 
> Automatic focus also uses this reference value, and if you find autofocus slightly off, you can **update the infinity focus value** in _Parameters → Settings_.**(See footnote ⑧ for details.)**

**3\. Long Exposure**

**Long exposures** greatly enhance the **signal-to-noise ratio (SNR)** of astrophotos, allowing faint celestial details to become visible. However, they can also **introduce challenges** in tracking celestial objects. Factors such as **tripod stability** , **light wind** , or even subtle ground vibrations may affect the tracking accuracy, causing **stars to appear elongated** or slightly blurred in the final image.

**4\. Manual Parameter Settings of DWARF 3**

**DWARF 3** allows users to freely adjust settings for different targets and environments. With manual exposure control, DWARF 3 is not just an _automatic_ telescope, but a **fully adjustable astrophotography tool**. By properly setting exposure, gain, filter, and frame count, you can balance brightness and noise under various lighting conditions and capture your own ideal night sky.

• **Exposure/Shutter Time**

Exposure time determines how long the sensor collects light. Long exposures are ideal for nebulae and galaxies, allowing more light to accumulate.

Recommended exposure: **15 – 60 seconds**.

• **Gain**

Gain is similar to a camera’s ISO. A higher value makes the image brighter but increases noise. **Low gain:** cleaner images and higher dynamic range, ideal for bright objects. **High gain:** stronger signal for faint targets, but requires noise control. Balancing exposure time and gain is key to achieving an optimal signal-to-noise ratio.

Recommended gain: **60 – 80**.

> In **Deep Sky Mode** , the **minimum gain for tele photo lens is limited to 40** , as lower gains can cause **vertical banding** in stacked astro images.

• **Filters**

DWARF 3 supports multiple filter options.

**VIS Filter**

The VIS filter blocks ultraviolet and infrared light while allowing visible light to pass through. It is ideal for **daytime or landscape photography** , helping preserve accurate natural colors and image sharpness under sunlight.

  * Spectral Range: 430–650 nm

**Astro Filter**

The Astro filter is designed for **deep-sky and wide-field astrophotography** , where you need to capture both visible and near-infrared light. It works best for **bright nebulae, galaxies, and star clusters** , helping reveal more structure and contrast in faint celestial objects.

  * Spectral Range: 430–690 nm

**Duo-Band Filter**

The Duo-Band filter is specially optimized for **emission nebulae** , transmitting two specific wavelengths — **Hα (656.3 nm)** and **OIII (500.7 nm)** — while blocking other light. This filter greatly increases nebular contrast and helps isolate fine gaseous details when the star field looks crowded or messy.

> When selecting a target in **Sky Atlas** , the recommended filter will be automatically shown and applied under **Auto Parameters**.
> 
> If you find the image filled with too many star points or scattered background stars, try switching to the **Duo-Band filter** for a cleaner and more defined result.

• **Frame Count**

You can set the total number of frames to capture—100, 200, 500, or more. Each frame will be automatically stacked later. The more frames you take, the **cleaner the signal** and the **richer the final details**.

Recommended frame count: **200 – 400 frames**.

**5.  Subframe Format**

DWARF 3 provides two **RAW image formats** for astrophotography — **TIFF** and **FITS**.

• **TIFF Format**

A TIFF file is a **high-quality raster image format** that uses lossless compression to preserve color and fine detail. It is widely used by photographers and graphic designers for **post-processing and visual editing** , making it ideal when you want to adjust your photos in standard editing software.

• **FITS Format**

A FITS file (**Flexible Image Transport System**) is the **standard format used in astronomy**. It was specifically designed to store scientific imaging data, including **photometric calibration, spatial information, and metadata about image origin**. This makes it the best choice for **scientific image stacking, calibration, and analysis** in tools such as _Stellar Studio_ , _PixInsight_ , or _AstroPixelProcessor_.

> Even if you select TIFF as the format, the final stacked image will be in FITS format, while the individual frames will be saved as TIFF.

**6\. Display Method**

DWARF 3 offers two display modes during astrophotography: **Single-Frame Preview** and **Stacked Image View**.

• **Single-Frame Preview**

Shows the most recent frame being captured in real time. This view is useful for **checking focus, exposure, and tracking accuracy** while shooting.

• **Stacked Image View**

Displays the **combined stacking result** that continuously updates as more frames are captured. This mode lets you monitor the gradual improvement of image quality and brightness during long exposures.

> You can **switch between the two modes at any time** during shooting. If you notice the stars drifting or becoming elongated in the single-frame preview, it may indicate tracking instability or tripod movement.

**7\. Mandatory Calibration**

The **Mandatory Calibration** option ensures that every GoTo operation is executed with the highest accuracy, making your astrophotography process **more reliable and precise**. When this setting is enabled, DWARF 3 performs a short calibration sequence before each GoTo to verify its orientation and positioning.

> However, calibration takes additional time. If you are already confident that the previous alignment is accurate and the **scope** **won't be moved again** , you may **disable this option**.
> 
> In that case, there won't be another round of calibration **when switching targets,** and the **manual calibration button** will appear on screen whenever you find GoTo is failed and a recalibration is needed. 

**8.  Update Infinity Focus**

The **Update Auto Focus (♾️) Position** feature allows you to manually redefine the telescope’s infinity focus point used for astrophotography.

If **autofocus fails** or does not produce sharp stars, manually adjust the focus until stars appear as fine and sharp as possible, then tap update the position here.

To do this:

• Go to **Focus** and manually adjust your **telephoto lens** on a star field or a **VERY** distant object.

• Return to **Parameter > Settings**, scroll down to **Update Auto Focus Position** , and press **Update**.

• The **three-digit value** displayed will change to your newly defined focus position, which will be used for future autofocus operations.

### 3.2.3 Dark Frames & Quick Apply

#### 3.2.3.1 What Are Dark Frames

Every camera sensor produces minor electronic noise, appearing as faint speckles, hot pixels, or uneven glow in photos, especially during long exposures. Therefore, we need to capture this dark noise and use it to neutralize our astrophotography images — this process is known as **dark frame calibration**. DWARF will require proper dark frames for each session.

To capture darks, use the DWARF’s built-in **Dark Frame** tool: (this will be covered again furhter down in this section)

  * Install the **ND filter**

  * Fully **retract the lens cylinder** (closed position)

  * Match **exposure, gain, and resolution** exactly to your light frames

  * Capture darks at a **temperature as close as possible** to your imaging session (this may involve you needing to place your DWARF device outside and let it aclimate to the current conditions)

  * Use the **same lens** you’ll be imaging with (Wide or Tele)

#### 3.2.3.2 Use Quick Apply to use a saved Parameter Set 

**Quick Apply** is accessed from **Session Settings** when **Auto-Parameter is turned off** (see image below). It allows you to quickly browse all dark frames currently stored on your DWARF device.

Your DWARF may already include several **factory-installed dark frames**. Each dark frame entry clearly lists its **exposure, gain, and resolution** , making it easy to identify which ones match your current session settings. These typically reflect the parameter combinations you use most often—since they were created to match your previous capture sessions.

So it is conveniently listed in the first row of the manual parameter panel, allowing you to **apply your favorite shooting settings with a single tap**.

>   * Dark frames captured with the **same exposure, gain, and resolution** but at **different temperatures** are automatically grouped together for easier browsing and selection.
> 
>   * Even if your exposure and gain are identical, you may still need to **recapture dark frames when the sensor temperature changes**. You can review all darks with non-matching temperatures in the **Dark Management** section.
> 
>   * The **current sensor temperature** is displayed on screen. If the temperature difference exceeds **±8 °C** , your DWARF will automatically prompt you to retake dark frames before starting the session.
> 
>   * You may **dismiss this prompt** and capture dark frames manually at a later time, but accuracy may be affected.
> 
> 

> 
>  

#### **3.2.3.3 Managing Dark Frames**

To manage your stored Dark Frames, you can access this option from the main app home screen by selecting **Settings > My Device > Image Calibration > Dark Frame. (**[**Section 1.4.2 - My Device**](https://tinyphoton.feishu.cn/wiki/VNGwwb3OeiCGngkYhsocyRAsn4e#share-V4S9dqN6FonFo9x1TQOczDCInAb)**)**

In the Dark Frame section, for every different set of parameters or each one-degree difference in temperature, a new entry will be created, and **each entry can store up to 20 dark frames**.

  * Tap "**Add Dark** " to capture new dark sets.

  * Adjust Shutter/Gain/Resolution/Total Sub Count

  * Telephoto Darks: 40 gain is the lowest setting allowed for DARKS, same as when adjusting parameters in Deep Sky Mode

  * Completion time will vary based on Shutter setting and total sub count

  * To "**Remove"** dark files, long-press any saved dark entry, select one or multiple, the press confirm to complete the process.

 

#### **3.2.3.4 When to Recapture Dark Frames?**

Before (or after) each astrophotography session, Your DWARF automatically checks whether the existing dark frames match your current shooting conditions. If any key parameters differ significantly, a new set of dark frames should be captured to ensure optimal stacking results. You should **recapture dark frames** in the following situations:

**1\. When shooting parameters change**

If you adjust the **exposure time, gain, or resolution** , the previous dark frames will no longer match the new settings. Some users have found taking an extra set of darks after a session is completed will greatly help with improving results, especially if you choose to use Megastack later to restack your session, which will apply the most appropriate darks found stored on the device. The temperature during your session may change significantly from when you started your session, so keep that in mind, especially during colder months.

Dark frames must **perfectly match your shooting parameters** in order to accurately remove sensor noise.

**2\. When ambient temperature changes significantly**

Large temperature shifts (typically greater than ±8 °C) alter the sensor’s thermal noise pattern, rendering old darks invalid.

It’s recommended to take new dark frames whenever the temperature changes substantially — especially when the night cools down rapidly, change in seasons (Summer / Winter)

Depending on the temperature at your location, having your device sit outside for 15 to 30 minutes prior to the start of a session will help your DWARF device acclimate to the external temperature and give you better results in capturing dark files. You can safely monitor the sensor temperature on screen to see how much of a change applied before starting and after.

**3\. When prompted “Dark Frame Missing” or “Dark Frame Mismatch”**

Your DWARF device automatically monitors its dark library and will alert you if the parameters or conditions are inconsistent.

Simply follow the on-screen instructions to perform a new dark capture, and the system will update your calibration frames accordingly

**4\. Where do I take Darks?**

Best practice is to capture dark frames in the **same—or at least a very similar—environment** where you’ll actually be using the device. You _can_ take darks indoors, but be aware that **warmer indoor temperatures will affect the results** and may not match real imaging conditions.

Many users take advantage of **cloudy or poor-weather nights** to capture darks outside. That’s not a wasted evening—it’s prep work that pays off on the next clear night.

Try to build a **library of darks across the temperature range** you expect to encounter during your outdoor sessions. Do that once, and future imaging becomes faster, cleaner, and far less frustrating.

### 3.2.4 Curves (Stretching Tool)

During shooting, you can adjust the **Curves** to fine-tune the **RGB color balance** and enhance the **overall brightness and contrast** of deep-sky objects. This process, known as **stretching** , redistributes pixel brightness to reveal more details.

>   * Curves Note:
> 
>     * Pulling down the **left side** of the curve darkens the background, while lifting the **right side** brightens nebulae and galaxies. If you’d like to explore advanced techniques, you can find many great tutorials online — but don’t worry, **sometimes it’s all about intuition!**
> 
>     * After adjusting, don’t forget to click **Save** — your edited photo will be saved **directly to your phone or tablet’s photo album as a JPEG only** , making it easy to share right away.
> 
>     * Any saved images or manual adjustments while using the curves function will **_NOT_** affect any individual subs or your final stacked image during a live session.
> 
>     * Click **Reset** to restore the previous curve settings.
> 
> 

### **3.2.5 Astro Mosaic**

**Astro Mosaic** refers to a technique in astrophotography where multiple adjacent images of the night sky are captured and then stitched together into one large, continuous picture. It allows you to photograph **celestial objects larger than a single frame’s field of view** , such as the **Veil Nebula**.

For detailed operation steps & more info, please refer to **_Section 3.9 Astro Mosaic_**.

### **3.2.6 Wide-Angle Astrophotography (The Milky Way)**

If you have the chance to visit a dark site with minimal light pollution, try capturing the **Milky Way,** the result will be stunning. Remember, light pollution greatly affects wide-field imaging quality.

Use the dedicated Milky Way Mode for wide-angle framing, AR assistance, and Locate Milky Way. For the complete workflow, see the [Milky Way Shooting Guide](https://help.dwarflab.com/en/docs/Milky-Way-Shooting-Guide) and the [Milky Way Time-Lapse Photography guide](https://help.dwarflab.com/en/docs/help-doc-5?product=dwarf-3).

**Note:** Wide-angle Astro Mosaic is not available in this release.

### **3.2.7 Star Trails**

> Before shooting, choose an open location with firm ground and mount DWARF 3 on a sturdy tripod. Make sure the device has enough power for a long session, and connect a power bank if needed. If you plan to include a building, tree line, or other foreground, check the location and viewing direction in advance and review the Moon phase and position; moonlight can help illuminate the foreground. Set up before dark when possible. If you must work in the dark, use a red headlamp to preserve your night vision.

  1. Tap the icon in the top-right corner to switch modes and enter Star Trails mode.

2\. **Check or Capture Wide-Angle Dark Frames**

Before shooting, make sure a matching set of wide-angle dark frames is available in the Dark Library. Star Trails mode automatically checks the library and matches darks based on the current shutter speed, gain, and capture temperature. A suitable dark set must meet the following conditions:

  * The shutter speed and gain match the current capture settings.
  * The dark-frame temperature is close to the current capture temperature, within ±8°C.
  * If a suitable set is already available, you do not need to capture another one. If no suitable darks are available, open the **Toolbox** on the left, tap **Darks** , select **Wide-angle Dark Field** , and follow the on-screen instructions.

> Note: Since star trails are captured using the wide-angle lens, the dark frames must also be taken with the wide-angle lens.

3\. Composition

  * Star trails can be captured in any direction, and each direction produces a different arc pattern. In the Northern Hemisphere, place Polaris as close to the center of the frame as possible for concentric-circle trails. In the Southern Hemisphere, use the Star Atlas to locate Sigma Octantis and use it as the reference for the rotation center. If your composition includes a building, tree line, or other foreground, place it along the lower edge or to either side, then take a few test shots before starting the session.
  * **Choosing your direction:** The appearance of star trails varies depending on the direction the camera is facing. To capture the **concentric circle effect** (circumpolar stars), please point the lens toward the **North**.

4\. Duration and Video Generation

  * **Trail length vs. Time:** The length of the star trails depends on your total shooting duration; the longer the session, the longer and more dramatic the trails will appear.

  * **Setting the duration:** You can select a shooting duration ranging from **30 to 360 minutes**. If you select **∞ (Infinite)** , the device will continue capturing until you manually stop it.

  * **Video output:** You can choose whether to automatically generate a star trail time-lapse and select your preferred video style.

Sample star trail video styles. Footage provided by user '阿靖婧婧'.

Classic Build-UpComet Style

> Both Classic Build-Up and Comet Style videos are generated at a fixed 30 fps. A video appears in the App album only after at least 30 frames have been accumulated. With fewer than 30 frames, the video file remains on the device and can be accessed from a computer.
> 
>  
> 
> To make the video appear in the App album, make sure the session records at least 30 exposure frames. The required total duration depends on the selected shutter speed.

5\. Parameters

  You can complete the parameter settings using either of the following methods:

  **Method 1: Automatic Settings**

  For your first capture, we recommend using the **Auto-Adjustment** mode.

  **Method 2: Quick Settings**

  Quick Settings will match parameters based on your existing Dark Library.

  **Method 3: Manual Settings**

  Manually adjust Shutter Speed and Gain.

> **Note:** You must disable **Auto-Adjustment** before you can use Quick or Manual settings.

Once you have configured the parameters, tap the shutter button to start capturing.

> **During the star trail stacking process, you will see a Red timer and a Black timer on the interface. Their meanings are as follows:**
> 
>   * **Red Timer:** Represents the **current shooting progress** , indicating the total duration the device has captured so far.
> 
>   * **Black Timer:** Represents the **stacking process** , indicating the total duration of exposures that the algorithm has successfully stacked.
> 
> 

### 3.2.8 Star Trail Restack Tutorial

Feature Introduction:

This feature allows you to manually remove frames containing airplane trails or defects after the initial star trail synthesis, and then restack the images. If you selected the option to generate a star trail video during shooting, the system will automatically update the video file after the re-stacking process.

Steps:

  1. Tap Album to enter the gallery.

  2. Select and enter the Mega Stack module.

  3. Select the star trail image that needs to be re-processed.  
 

  4. Tap the Single Image Management button.

  5. Check the unwanted frames or frames with airplane trails in the list.

  6. Tap Delete to remove the selected frames.

  7. Return to the main Mega Stack interface, select the processed image, and tap Stack.

  8. Wait for the system to complete the stacking progress.

  9. A new stacked photo and the updated video will be automatically regenerated in the Album.

> Note：Mega Stack supports re-stacking Star Trails data. After you select one Star Trails target, only data for that target remains selectable; other Star Trails targets and other astronomy targets are disabled.

## 3.3 Solar System Mode

In this mode, you can use different formats like **Astro stacking photos or** **time-lapse videos** to shoot the **Sun, Moon, and other planets** in the Solar System.

> **Solar System Mode Note:**
> 
> DWARF 3 is not designed or optimized for planetary imaging. Its small aperture and imaging system are intended for wide-field and deep-sky targets, not high-resolution planetary detail.
> 
> Example: You can expect Jupiter and Saturn to appear primarily as **bright points or very small disks** , with limited color information. Under good conditions, you may see **Jupiter’s larger moons as separate points of light** , and in rare cases Saturn’s rings may be faintly suggested, but not resolved with detail.
> 
> That said, experimentation is encouraged. Many users continue to push the device creatively and capture results that exceed expectations within these constraints.

### 3.3.1 Solar Imaging

Solar imaging with **DWARF 3** allows you to safely capture detailed photos and videos of the Sun’s surface, including sunspots and other dynamic solar features. With precise auto-tracking and focus, DWARF 3 can follow the Sun’s movement across the sky. By using the **included ND solar filter** , the telescope reduces the Sun’s brightness to a safe level for both the sensor and your eyes.

**Steps:**

  1. **Place DWARF 3 on a stable, flat surface and power on** the device and **connect** it to your phone or tablet. Keep the front of the telescope body facing forward.

  2. Enter**Solar System Mode.** Select**Sun.**  

  1. Attach the **Solar Filter**. Use the dual-lens to locate the Sun in the tele frame (**roughly center**).

Once the preparations above are complete, please tap "Done Already."

  4. Tap **"Track"** and the sun will be precisely**centered, focused and tracked**.

> **🔭  Device Note:** The telescope cylinder will first retract briefly to recalibrate before stable tracking begins. You may notice a brief pause in viewing before it restarts tracking and alignment.

  5. When tracking the Sun, tap “2x/1x” on the right side of the screen to toggle between 1x and 2x views.

> 📷  The **1x** view offers **4K** sizing with a wider field of view, while the **2x** view provides a **1080p** cropped image, making the sun appear larger.

> **Note** : Magnification cannot be changed once you tap 'Start Capture' in the next step.

  6. Tap **Shoot** to start imaging — the **auto parameters** are already optimized for solar capture.

  6. You can also switch to **Video Mode** or **Time-lapse Mode** to record the Sun in different styles.

> Additional Solar Notes:
> 
>   * **Exposure caution:** Other shooting modes **cannot automatically optimize shutter settings** for the Sun or Moon. You may get overexposed images.
> 
>   * **Recommended session settings:** For your first capture, start with **20–30 images** per session. You can set up to 999 images, but long sessions increase **heat exposure** , which may trigger safety shutdowns. DWARF 3’s recommended **sensor operating temperature is below 60°C (140°F)**. If the internal temperature reaches this limit, the device will **automatically shut down** to protect itself.
> 
>   * **Auto-focus:** During auto-focus, the camera adjusts exposure and gains automatically—typically around **1/250s–1/200s exposure** , **gain = 0** , and **VIS filter** applied. You can manually adjust **hue and white balance** if desired.
> 
>   * **Lens orientation:** Since there’s no "astro" calibration for Sun or Moon tracking, **keep the lens cylinder facing forward** (DWARFLAB logo side) while tracking to ensure accurate alignment.
> 
> 

### 3.3.2 Moon Imaging

DWARF 3 lets you capture the Moon’s **craters, mountains, and subtle shadows** in impressive detail. Using its **telephoto lens** and **built-in tracking system** , DWARF 3 automatically follows the Moon’s motion, keeping it centered for sharp, stable shots.

You can capture **single images, videos, or time-lapses** to document the Moon’s changing light and surface textures throughout its phases.

> Moon imaging works similarly to solar imaging, with a few key differences:
> 
>   * **No ND filter needed:** Unlike the Sun, the Moon does not require a neutral density filter.
> 
>   * **Best timing:** nighttime is ideal, when the Moon is most visible.
> 
>   * **Daytime or evening imaging:** You can also capture the Moon during daylight, generally **late afternoon or early evening** , as long as it is bright enough and unobstructed for DWARF 3 to detect and track.
> 
> 

**Steps:**

  1. **Place DWARF 3 on a stable, flat surface and power on** the device and **connect** it to your phone or tablet. Keep the front of the telescope body facing forward.

  2. Enter**Solar System Mode.** Select**Moon.**

  3. Use the dual-lens to locate the Moon in the tele frame (**roughly center**).

  4. Tap **"Track"** and the moon will be precisely **centered, focused, and tracked**.

> **🔭。Device Note:** The telescope cylinder will first retract briefly to recalibrate before stable tracking begins. You may notice a brief pause in viewing before it restarts tracking and alignment.

  5. When tracking the Moon, tap “2x/1x” on the right side of the screen to toggle between 1x and 2x views.

> 📷  The **1x** view offers **4K** sizing with a wider field of view, while the **2x** view provides a **1080p** cropped image, making the moon appear larger.

> Note: Magnification cannot be changed once you tap 'Start Capture' in the next step.

  6. Tap **Shoot** to start imaging — the **auto parameters** are already optimized for moon capture.

  7. You can also switch to **Video Mode** or **Time-lapse Mode** to record the Moon in different styles.

> Additional Moon Notes:
> 
>   * **Exposure caution:** Other shooting modes cannot automatically adjust shutter settings for the Sun or Moon, so overexposed images are possible.
> 
>   * **Lens orientation:** Since there’s no "astro" calibration for Sun or Moon tracking, always keep the **lens cylinder facing forward** (toward the DWARFLAB logo) to ensure accurate tracking.
> 
> 

### 3.3.3 Sun and Moon Tracking Updates

In Solar System mode, select the Sun or Moon and start tracking. DWARF centers the target, focuses, and applies the capture settings in one step. The device does not need to remain level and can track from a suitable orientation.

Automatic detection may fail during eclipses or when clouds obscure the target. If the Sun is not detected, the App asks you to bring it into the tele view; tap Retry, or use Ignore Detection to continue after confirming the target and safe operating conditions.

For video, burst, and time-lapse capture, Solar System mode provides white balance, brightness, contrast, hue, saturation, and sharpness controls. These color controls remain at their defaults and are disabled for FITS stacking captures.

## 3.4 Auto Capture Mode

Follow these steps to use DWARF 3 to automatically detect, track, and record fun things around you.

### 3.4.1 Ground Auto Capture

**Steps**

  1. **Face the Target**

Point the telescope lens roughly toward the direction of your target.

  2. **Choose Target & Auto Record**

From the **bottom menu** , select the type of target you want to **auto-track**. DWARF will automatically search for the selected target through both the **wide-angle** and **telephoto** area, **identify it** , and begin **tracking and recording** with the telephoto lens.**(Recommend enable AF-C in focus panel)**

Currently, DWARF can recognize and track **six types of terrestrial objects** : **birds, people, dogs, cars, airplanes, and boats.**

>   * To achieve the best detection results, do not manually select tracking objects or perform operations such as moving the device during the target detection phase.
> 
>   * If detection fails, check whether the target is within the frame and whether it appears clearly focused in the telephoto view. You can use the **joystick** or tap **Auto Focus** to adjust the view if needed. Of course, you can also adjust parameters in the Function menu anytime.
> 
>   * When the internal storage is less than 1GB, recording will automatically stop and save. When the battery is below 7%, shooting will automatically stop and save.
> 
> 

### 3.4.2 Sky Auto Capture (UFO)

#### 3.4.2.1 Face the Target & Adjust Focus

Click 'UFO' icon and follow the guide to complete the focus. Point the camera to the night sky and ensure no ground objects are in the field of view of either lens. DWARF will keep rotating and scanning for moving bright spots in the night sky, initiate tracking, and start recording, allowing you to fully enjoy the unmanned shooting experience.

#### 3.4.2.2 Fixed Spot & Auto Scan

When locked, the device enters fixed-spot mode, detecting UFO at a fixed location. Once unlocked, it switches to Auto-Scan mode to scan the entire sky for UFOs.

To prevent damage from the sun during scans, the Auto-Scan mode is disabled during the daytime.

## 3.5 Panorama Mode

Capture every detail of the scene before you: use the **telephoto lens** to take multiple high-resolution photos and stitch them together into one stunning panoramic image that reveals incredible clarity and scale.

Follow these steps to create your own professional **gigapixel panorama**!

### 

### 3.5.1 Switch to Panoramic Mode

Click the icon in the upper right corner to switch modes and enter the panoramic mode.

### 3.5.2 Place DWARF

After the base positioning points are aligned, the Logo surface and the lens remain on the same plane and face the center of the frame to be captured.

### 3.5.3 Focus

Switch to the telephoto lens for focusing. Click T (Telephoto)/W (Wide Angle) to switch lenses, or directly click on the viewfinder to switch.

> Panoramic shooting uses a telephoto lens, so please adjust the focus position in the telephoto field of view.

### 3.5.4 Set telephoto parameters

Click Parameter - Telephoto

### 3.5.5 Composition and Shooting

> To help you obtain high-quality stitched panoramic images, we recommend:
> 
>   1. Please try to keep the DWARF3 lens level when shooting.
> 
>   2. Choose a bright shooting scene.
> 
>   3. Reduce the sky background (moving clouds).
> 
>   4. The shooting targets have distinct features and are non-repetitive.
> 
> 

**Method 1: Start shooting directly after setting the shooting rows and columns**

> Rows × Columns represents the number of images to be captured.  
> For example, if you select 5 rows × 5 columns,DWARF will capture 25 images and generate a panoramic image.

**Method 2: Manually compose the shot and then confirm the capture**

Click to manually compose the image

Drag the panorama frame to select the shooting range

> DWARF will initially capture a preview image to show the shootable range, and this preview does not represent the final footage effect.

> The "Telephoto Panorama 30* 37" in the upper right corner indicates that the shooting grid is 30 rows × 37 columns, and DWARF will complete the shooting according to this quantity.
> 
> You can also click the icon in the bottom left corner to view the framing gridlines of the current framing range.
> 
> When the preview image does not match the real-time image (e.g., after adjusting the DWARF position), you can click the refresh button in the lower right corner to reload the viewfinder preview.

Click to confirm shooting

> DWARF will automatically take photos based on the number of rows and columns or the composition range you set.  
> During the shooting process, the screen will display the shooting progress:Number of photos taken / Total number of photos to be taken.

### 3.5.6 Pano Weave

The preview image displayed in the album is a locally quickly stitched one. If you need to generate a high-precision panoramic image, please upload the photos to the cloud for stitching.

When uploading a panoramic jigsaw using WiFi, if you are prompted to connect in STA mode, the steps are as follows.

### 3.5.7 Panoramic Image Adjustment

 _Credit: Mark Bahu, shot by DWARF 3_

> In the previous sections, we’ve introduced the **main interface** and explained how to use each **shooting mode** for different scenes.
> 
> In the following chapters, we’ll explore DWARF 3’s **signature advanced features** — including **Stellar Studio (SS)** and **Mega Stack (MS)** for astrophotography post-processing, as well as **advanced shooting techniques** like **mosaic imaging** and **scheduled deep-sky captures**. Let's dig in!

## 3.6 Stellar Studio

**Steller Studio** is the post-processing companion to your DWARF 3 Smart Telescope. It transforms raw image data captured by the telescope into polished, detailed astrophotos. After a session, open Album from the DWARFLAB App homepage, then select Stellar Studio. Stellar Studio supports stacked telephoto and wide-angle deep-sky images, as well as eligible Sun and Moon stacks. Available processing tools vary by source type.

> **January 2026 Update** : we have included the option to upload Solar and Moon stacked sessions

After completing your Astro session, navigate to the **DWARFLAB App homepage, select Album, then at the top, select Stellar Studio.** Stellar Studio is designed specifically for Telephoto and Wide Angle deep-sky objects (DSO's).

> **Important Stellar Studio Notes:**
> 
> Stellar Studio requires you to **upload stacked image files** from the DWARF telescope to an **online (cloud) server**.
> 
>   * Your phone or tablet must be connected to a **stable internet connection**. Using **STA mode** is recommended.
> 
>   * If your connection is unstable, uploads may **fail or be delayed** , preventing the process from completing.
> 
>   * Stellar Studio may display a queue or numbered postion in the order it receives your files when uploading or processing the data. This is expected during high usage/high volume of uploads and downloads by other DWARF device users.
> 
>   * Stellar Studio may be temporarily unavailable due to **maintenance or server issues**. DWARFLAB will work with our server providers to **restore services as quickly as possible**.
> 
> 

### 3.6.1 Processing Features

Click one of the various options to start the processing of your stacked image

#### 3.6.1.1 Auto Mode

Automatically corrects star shapes, reduces noise, and enhances background uniformity.

#### 3.6.1.2 Star Correction

  * Adjusts only the shape of stars.

#### 3.6.1.3 Noise Reduction

  * Performs only noise reduction on the image.

#### 3.6.1.4 Star Removal

  * Only removes all stars from the image, leaving a pure nebula view.

#### 3.6.1.5 Crop and Watermark

Use **Crop** to refine the composition and orientation of an astrophotography image. Use **Watermark** to add a template, device branding, target information, capture location, and a caption. When everything looks right, download the finished image from the Edit page.

  1. **Open the Edit Page**

On the astrophotography post-processing screen, find the bottom toolbar and tap **Edit** , the option on the far right.

The Edit page has three main controls: **Download** in the upper-right corner saves the finished image; **Crop** at the bottom left opens the crop and rotation tools; and **Watermark** at the bottom right opens the watermark tools.

  2. **Crop the Image**

Tap **Crop** on the Edit page to open the crop tools. The controls below can be used in any order and combined as needed. The preview updates while you work.

  3. **Adjust the crop frame and image size**

The white crop frame is the part of the image that will be kept. Drag any of the four corner handles or any white edge handle to adjust the crop frame. Keep **Free** selected when you want to adjust width and height independently.

Use two fingers directly on the image to pinch out and enlarge it, or pinch in to make it smaller. You can then drag the image to position the subject inside the crop frame.

  4. **Choose an aspect ratio**

Tap the ratio you need: **Free** , **1:1** , **16:9** , **9:16** , **4:3** , or **3:4**. Swipe left across the ratio list to reveal any additional ratios. The selected ratio turns green and the frame updates immediately.

  5. **Rotate and straighten**

Tap **90 degrees** on the left side of the ruler to rotate the image clockwise by 90 degrees. Drag the angle ruler left or right for fine adjustment; the current angle appears above the center marker. You can continue adjusting the crop frame or image size after rotating.

  6. **Apply, reset, or cancel**

     * Tap **Reset** in the upper-right corner to restore the original crop and rotation.
     * Tap **X** at the bottom left to cancel. If changes have been made, confirm whether to discard them.
     * Tap the **check mark** at the bottom right to apply the crop and return to the Edit page.
     *   7. **Add a Watermark**

From the Edit page, tap **Watermark** at the bottom right.

  8. **Select a watermark template**

Tap a template thumbnail to apply it. There are currently eight templates. Each template displays a different combination and layout of information, such as the target name, device information, capture settings, date and time, and caption. The selected template has a green border, and the preview above updates immediately. Swipe left across the template list to see more templates. Tap the crossed-circle icon if you do not want a watermark.

  9. **Open Edit content**

Tap the selected template again, or tap the pencil shown over its thumbnail, to open **Edit content**.

  10. **Choose device branding**

Under **Device** , choose whether the watermark shows the device name or the device logo. The preview at the top updates as soon as you select an option.

  11. **Set the target name**

Tap **Target name**. Select the detected target name when it is correct, or choose **Custom** to enter a different name.

After choosing **Custom** , enter a name and tap **Confirm**.

  12. **Set the capture location**

Tap **Capture location** , then choose one of the available options: **Precise** shows the exact location when location data is available; **Approximate** shows the location at city level; **Don't show** hides the location; and **Custom** lets you enter your own location text.

Unavailable options appear dimmed when the image has no matching location data. When you choose **Custom** , enter your own location text, then tap **Confirm**.

  13. **Add a signature and choose its font**

Templates with a signature field display a default value such as **@See Further**. Tap it to enter or change the signature. Tap a font card to choose how the signature appears. To see all 13 font options, tap **Expand** , then swipe up to browse and select a font.

  14. **Add or generate a caption**

Tap **Suggested Wording** below the Caption field to generate a caption suggestion. The generated text appears in the same caption input used for manual entry, so you can review and edit it before continuing.

To write your own caption, tap the **Caption** field and enter up to 210 characters. The caption updates on the image preview as you type. Tap **Confirm** to close the caption input.

  15. **Save the watermark**

Use the Android back gesture or Back button to close the Edit content panel. Review the full preview, then tap **Save** in the upper-right corner to return to the Edit page.

  16. **Download the Finished Image**

On the Edit page, check the crop, watermark, target information, location, and caption one last time. Tap **Download** in the upper-right corner to save the finished image.

After the download completes, **Saved to System Album** confirms that the image is in your device's photo album. Tap **Done** to close this page. Use **Share** to open the system share sheet, or **Share to PhotonVerse** to send the image to PhotonVerse.

  17. **Recommended Order**

Crop first, then add the watermark. Cropping after watermark setup can change the composition and may require you to review the watermark again before downloading.

### 3.6.2 Viewing Results (Task List)

Processed results can be viewed in the **Task** list.

> Note: You can apply multiple processing features to the same image, generating separate result images under the same title in the task list.

Similarly, you can process an already processed image for multiple times, but **new results will overwrite previous ones** , and the **task name** will reflect the **latest** processing step.

### 3.6.3 Downloading & Saving Processed Files

Clicking **download** will save a **JPG** or**a 16 bit PNG (stretched)** to your phone’s system album (for viewing & sharing). 

> We recommend sharing images directly, and for post-processing, using **PNG** is better as it preserves **more detail in highlights and shadows**.

A **RAW file (FITS format)** will be stored in the cloud server for further processing.

> **How to Access Cloud Files:**
> 
> Currently, the process to access "cloud" files has two available steps, copy link or sharing the link. By copying and "paste" the link into a browser on your **phone/tablet or typing it into a computer web browser, you can then start the process** to download the file for further use in post-processing applications. Newer operating systems on both phones and tablets (Apple or Android) give some functionality to allow users to save these file types in the file or folder structure on your personal device. If you have a file sharing or storage service (ex Google Drive, OneDrive), it may allow you to save directly to that. Please research how your personal devices can save these file types.
> 
> _(This process may get updates in the future to assist users with a better method of file saving)_

> **Additional Stellar Studio Notes:**
> 
> **Storage location:** **JPG** and **PNG** post-processed images are **not saved on your DWARF device**. They are stored directly in your **phone or tablet photo albums**.
> 
> **Image cropping:** Processed photos may appear **cropped** compared to the version in the app’s album. This cropping removes **field rotation artifacts**. To minimize cropping, we recommend **shooting in EQ mode**.
> 
>   * Some images may appear excessively cropped. We are **working on improving this process or adding additional user options** , so future updates should preserve more of the image edges.
> 
> 

> 
> **Files moved off the DWARF:**
> 
>   * If a file or folder is **manually moved** off the DWARF device (e.g., to an external drive or PC) and then returned, it will be recognized as an **unknown file**. Stellar Studio cannot process it.
> 
>   * You can **re-stack the original sub-frames** in **Mega Stack** to generate a new valid file that Stellar Studio can recognize. See the Mega Stack section for additional information.
> 
> 

> 
> **Mosaic sessions:** Re-stacking and processing **mosaic images** is **not supported (** if removed from the device**)**. Once a mosaic session is moved off your DWARF, it **cannot be reprocessed** in Stellar Studio. This feature may be considered in future updates depending on feasibility.

### 3.6.4 Star Reduction, Star Spikes, and Stars Only

**Star Reduction** reduces star size and minimizes distractions so the nebula or other target stands out more clearly.

**Star Spikes** adds diffraction-style spikes to bright stars. Tap **Spikes** , choose a style, then tap the check mark to confirm.

**Stars Only** creates a stars-only result by removing the main background and target detail. The three tools are available together in the bottom menu; swipe the menu horizontally when **Stars Only** is off-screen.

## 3.6.5 Sun and Moon Processing in Stellar Studio

On the Select Photo page in Stellar Studio, choose a stacked telephoto Sun or Moon image/session. Upload, queue, and task-list behavior follows the deep-sky workflow.

For data identified as Sun or Moon, Star Correction, Noise Reduction, and Star Removal are disabled. Use only the tools currently enabled in the interface.

## 3.7 Mega Stack

**Mega Stack** is a powerful new feature built in to the DWARF 3 that allows you to stack images captured over multiple sessions, breaking the limit of single-session stacking. By combining data from different nights, you can reveal incredible details in deep-sky targets that were previously hidden. This is especially useful for faint nebulae and galaxies — the more you stack, the more you see!

Open Mega Stack and select compatible data. Deep-sky data can now be combined across filters, and multiple Astro Mosaic sets are supported. The App and device continue to **validate lens type, resolution, image type, and coordinate compatibility.**

Before stacking, you can tap **View Single Frames** to review individual images and delete any unsuitable ones before proceeding.

> In the screenshot below, the image marked with an exclamation mark indicates that this frame was **rejected during stacking** , likely due to **clouds, glare, or poor tracking**.

**Waiting for your work** \- Processing and stacking is all completed inside the DWARF and may take a short time or several hours based on the amount of individual frames you are combining to the stack. You **_must_** keep the DWARF in a "powered-on" state, but you can safely disconnect your phone or tablet while it completes the task. After completion, your results will be saved in the App's album. (Don't forget to plug in your DWARF device to a power source!)

### 3.7.1 Mega Stack Tips

  * For deep-sky Mega Stack tasks, lens type and resolution must match, and all selected data must be either Astro Mosaic or non-mosaic. Filters, shutter speed, gain, date, and capture location may differ.
  * Unlike other features in Infinity Lab, **Mega Stack _does not_ involve any cloud-based processing**. All image stacking is performed **locally on the device (onboard the telescope itself)**. It does not require you to connect through STA mode to start or finish the process.
  * MegaStack supports restacking of data captured with **Firmware Version v1.1.8 or later**. DWARF image files that have been moved off the device for storage purposes can be copied back for processing — make sure **_not_ to rename the files**.
  * If you intend to use any files in Stellar Studio after they are copied back to the DWARF's file storage, you **MUST** use **_Mega Stack_** to process and stack the frames again before they will be recognized for **_Stellar Studio_** to process. If you're wondering where you need to put your files at, be sure to read over the following document to understand the file structure in the DWARF device, "[**Get to Know the Files Stored in DWARF 3**](https://help.dwarflab.com/en/docs/How-to-View-and-Obtain-the-Files-on-DWARF-3?product=dwarf-3)
  * MegaStack is designed primarily for **deep-sky objects** , but now also supports re-stacking for single-session **Sun and Moon** captures. Please note that for this case, only **single-session** stacking is supported, as sunspots and the Moon’s rotation can affect alignment among frames of different sessions.

  * Mega Stack now supports multiple Astro Mosaic sets. Mosaic data can be combined only with other mosaic data, and every sub-frame coordinate must fall within the device's stacking tolerance. If any sub-frame is incompatible, the task does not start and the App reports that the selected images cannot be stacked together.
  *   * The current Mega Stack feature is quite sensitive to star quality and alignment. If there are**frames where the stars appear stretched or have noticeable trailing in any session** , it can cause the entire stacking process to fail — even if just a few frames are affected.

  * Although dark data is **embedded** during the initial shooting process, **Mega Stack allows you to reprocess with newly captured dark frames** — especially helpful when temperature conditions have changed, just retake dark frames and then restack the session. This process is automated and will use the best available darks that match your session parameters. This is a good time to re-do your darks if you choose to use Megastack.

### 3.7.2 Multi-Mosaic and Cross-Filter Stacking

After you select the first data set, the App disables items with a different lens type, resolution, or image type.

When you tap Stack, the device validates the target and mosaic sub-frame coordinates.

If dark data is missing, the App prompts you to capture matching darks.

  * Although dark data is **embedded** during the initial shooting process, **Mega Stack allows you to reprocess with newly captured dark frames** — especially helpful when temperature conditions have changed, just retake dark frames and then restack the session. This process is automated and will use the best available darks that match your session parameters. This is a good time to re-do your darks if you choose to use Megastack

## 3.8 Schedule Shooting

Schedule Shooting allows you to capture celestial objects late at night without staying up. Simply set up your DWARF telescope, which will independently complete the task without supervision. Check the weather forecast to ensure you don't miss any clear night skies due to unexpected conditions!

There are two ways to schedule a shooting:

  1. Creating a plan directly from the Homepage

  2. Creating a plan from the Atlas.

In the next two sections, we’ll take a closer look at these features in detail.

### 3.8.1 Create a Shooting Plan Directly

1\. **Create a plan** : Follow the prompts to create a plan, fill in the plan name, select the shooting time, and save it.

2\. **Edit Plan** : Open an existing plan. On the plan overview, tap the plan name to rename it, tap the date to change the plan date, or tap an existing target card to edit that target.

When editing the plan name, tap Save to keep the change or Cancel to leave it unchanged.

When editing the date, choose another date, then tap OK. The picker shows the automatically calculated sunset and sunrise times.

Tap Scheduled Capture Options in the plan card for settings that apply to every target.

Under **Scheduled Capture Options** , Lock Focus keeps the current focus position and **Skip Calibration** skips automatic calibration when the setup has already been calibrated.

Tap an existing target card to review its altitude curve and adjust settings such as **Shutter** and **Gain**.

**Set capture parameters:** For DWARF 3, the maximum shutter time per scheduled frame is **120 seconds**. When setting an exposure longer than 30 seconds, the App reminds you to roughly polar align your DWARF.

**3\. Add a target:** Tap an empty time slot **above or below an existing target card** in the schedule, or tap **+** in the lower-right corner.

After either entry, choose **Input Coordinates** to enter a target manually, or choose **Add Recommended Target** to select from the target list.

On the Target page, tap the **Target** field, then choose a recommended object or scroll for more choices. The first time you add a target, the App asks to download the Atlas database; tap **Download Now** and wait for it to finish before the target list becomes available.

**Use the altitude curve:** The entire curve represents the time span **from sunrise to sunset**.

  * The **red section** of the curve indicates that the target’s altitude is **below 30°** , while the **blue section** means the altitude is **above 30°**.

  * For the best results, schedule the session within the **blue zone**. The App shows the exact altitude as you drag the start and end times.

>   1. Due to various dynamic factors, the number of frames cannot be set manually. The system will automatically capture the maximum possible frames within the scheduled time.
>   2. For DWARF 3, the maximum exposure time per scheduled frame is 120 seconds. Use the range shown for the selected device. Longer exposures require more accurate equatorial alignment and stable conditions. When you set an exposure longer than 30 seconds, the App reminds you to roughly polar align your DWARF.
>   3. In schedule shooting it automatically set appropriate filters for some common targets, with other targets defaulting to astro filters.
> 

**4\. Synchronize Plan:** When the plan is ready and shows **Pending Sync** , tap **Sync**. Sync is available only within 12 hours before the scheduled start time; if it is too early, the App shows the earliest time at which you can sync. The App then confirms **Sync Complete** ; review the reminder to keep DWARF positioned, powered, and ready for the session, then tap **OK**.

Synchronization is **possible** within the **valid** timeframe.

After a successful sync, the plan status changes to **To Be Commenced** and the bottom action changes to **Edit Schedule**.

**5\. Modify a synced plan:** Before the plan starts, tap **Edit Schedule**. The App warns that you must sync again after editing. Tap **Continue Editing** to release the current sync, then change the plan name, targets, dates, or capture settings as needed.

The plan returns to **Pending Sync**. Save your changes and tap **Sync** again to send the revised plan to DWARF.

6\. **Preparation for Shooting**

Once synchronization is complete, secure the following items are fulfilled:

  * **Sufficient Power** : verify the DWARF device is fully charged.

  * **Correct Placement** : Position the DWARF in the appropriate location.

  * **Disconnect and Leave** : After all preparations are complete, disconnect your device and step away. DWARF will automatically enter sleep mode and wake up at the scheduled start time.

  * **Do Not Power Off** : Ensure you do not hit the power off button.

>   * When DWARF is in **Sleep Mode** , it looks almost identical to being powered off — no lights, no signals. However, the cylinder (lens) will NOT rotate closed and stay in its open position for it to better process its position and start the scheduled session when the start time begins.
> 
>   * When your scheduled shooting session has been completed, the cylinder will rotate close to a secure position to protect it. This is also helpful incase your session goes into the daylight hours. As some will notice, it does not completely close (maybe 95%, but this is normal and should not worry the operator)
>   * Regarding EQ Mode: You can use EQ mode in Schedule Shooting to align the DWARF with the polar axis in advance. Also, you may turn off the ring light for better results.
>   * Regarding Dark Frames: Check the dark frame files before shooting to ensure there are corresponding frames available for stacking. If not, you can capture them now.
>   * Do Not Power Off: DWARF will enter sleep mode after 15 minutes of inactivity when disconnected to save power. **In sleep mode, all indicator lights remain off. The device appears completely powered off, but it is in a extremely low-power standby state. But it** i**s not completely powered off and will automatically wake up before the scheduled time.** Do not long-press the power button, as this powers off DWARF and clears the synced schedule.
> 
>   * Sleep mode and the scheduled shooting function are completely independent. Sleep mode is a power-saving feature that automatically activates 15 minutes after the device is idle and not connected to external power. This behavior applies under all conditions.
>   * If your DWARF is connected to external power and you have set up a scheduled session but notice that the device does not enter sleep mode, there’s no need to worry — the scheduled shooting will still start normally. Even if the device enters sleep mode later (for example, if charging stops during the waiting period), the scheduled session will still begin as expected.
> 

  * **Unexpected Issues** :

  * If you accidentally **power off** the device after synchronizing the plan, please **power it back on** ,**cancel** the synchronization, and **re-sync** the plan. Then, let the DWARF enter sleep mode naturally.

  * To wake DWARF 3 from Sleep Mode, short-press the power button once. This wakes the device and does not power it off. Do not long-press the power button, as this fully powers off DWARF and clears the synced shooting plan. Restarting will refresh DWARF’s schedule memory, so don’t forget to re-sync your shooting plan for the day.

  * DWARF will **not** enter sleep mode while charging. It will only enter sleep mode to save power once the charging stops.

7.**Plan Execution Status**

Your shooting plan will have the following statuses:

**Pending Synchronization** , **To Be Commenced** , **Shooting** , **Schedule Accomplished** , and **Schedule Expired**.

You can connect to a DWARF at any time to check the plan’s execution status. If you encounter a plan execution failure, please upload the log in Settings - Support to get assistance.

### 

Open a plan and tap **Scheduled Capture Options**. These settings apply to every target in the current plan. They can be changed only while the plan is in **Pending Sync** ; in other states, the current values remain visible but the switches are disabled. Both options are off by default.

### 3.8.2 Create Plan from Atlas

From the Atlas, you can freely browse and click on a target to directly plan its shooting. To commence, you need:

1.**Choose the Right Time** : click the time icon in the bottom-right corner to select the time you plan to shoot. The Atlas will update to reflect the sky at the selected time.

2\. **View Targets** : Click the top-right corner to view recommended targets or search for targets to see their visibility.

3\. **Select a Target** : Choose your desired target. Swipe the menu to add it to the shooting plan.

Go back to the homepage to check your newly set shooting plan. All subsequent actions and precautions are listed in the previous section.

### 3.8.3 Schedule A Mosaic!

If you’d like to schedule an **Astro Mosaic shoot** , you’ll first need to**select your target** and **adjust the preview frame** to your desired composition. Then, swipe up the bottom menu and choose **“Add to Schedule.”**

**Mosaic imaging requires higher precision** , so make sure your **equatorial alignment is properly set** (roughly aligned if planning during daytime). For a step-by-step guide, **be sure to read “Learn More”** in the app.

With the Schedule Shooting feature, capturing stunning deep-sky objects has never been easier. Whether you’re planning a night-long astrophotography marathon or simply want to automate your stargazing experience, DWARF 3 ensures precision and convenience!

### 3.8.4 Fixed Focus and Skip Calibration

Open a plan and tap **Scheduled Capture Options**. These settings apply to every target in the current plan. They can be changed only while the plan is in **Pending Sync** ; in other states, the current values remain visible but the switches are disabled. Both options are off by default.

**Lock Focus:** Enable this after completing precise manual focusing. The schedule uses the current focus position instead of running infinity autofocus, then continues with calibration, GoTo, tracking, and capture.

**Skip Calibration:** Enable this only after completing the full target-preparation flow in advance and confirming that the device has a valid calibration result. The schedule skips infinity autofocus and three-star calibration, then proceeds to GoTo, tracking, and capture. Keep the device and lens position unchanged.

If no valid calibration is available, the device automatically runs the default preparation flow to help prevent capture failure. When a plan is duplicated, Lock Focus and Skip Calibration are not copied; both switches reset to off.

### 3.8.5 Multi-Target and Back-to-Back Plans

A single plan can contain multiple targets. No minimum interval is required between adjacent targets: the next target can start as soon as the previous target ends. Set the targets in execution order and review the time and capture parameters for each one.

Each target must be scheduled for at least 10 minutes. If a target is shorter than 10 minutes, the App blocks saving and asks you to adjust its time. If any part of a target's scheduled window falls below the horizon, the App shows a red warning; adjust the time or remove the target before syncing.

You can sync a plan at any time before its overall end time. If you sync before the plan starts, the device waits until the scheduled start time. If you sync after the plan has started but before it ends, the device starts the remaining available capture flow from the current time. In a multi-target plan, targets whose end time has already passed are not executed; if the current time falls within a target time block, the device starts the available flow for that target. If too little time remains to complete preparation or capture, the App reports **Capture Time Too Short**. After the plan end time, the plan is expired and the Sync button is no longer shown.

Schedule cards identify the associated device, such as DWARF 2, DWARF 3, DWARF mini, or Draco. When a device is connected, **This Device** shows only schedules already synced to that device. This tab is hidden when no device is connected and updates when you switch devices.

### 3.8.6 Copy and Edit Shooting Plans

Open the plan menu and tap **Duplicate**. Duplicate is available for schedules in any state and opens a new, editable plan. You can change the name, location, date, target times, and other editable details before saving.

The copy retains the original targets, time blocks, and capture parameters, but it does not retain the original location. Automatic location is enabled when the copy opens. Lock Focus and Skip Calibration are also not copied; both reset to off. The copied schedule is unsynced and remains independent from the original.

The App generates a copy name from the original name and adds a number for later copies. The plan date is updated using the current location's sunrise: before sunrise, the copy uses the previous date; after sunrise, it uses the current date. Review the generated name, location, date, targets, and settings before saving and syncing.

To edit a synced schedule in **Waiting to Start** , tap **Edit Schedule**. If needed, connect to the device first, then confirm that editing will release the current sync. You can change existing targets or add new ones. Save the changes and tap **Resync** to send the updated schedule to the device. This edit flow does not apply to other schedule states.

### 3.8.7 Auto Shutdown

Go to **Me > My Device > Auto Power Off**. Auto Power Off is enabled by default on DWARF 3.

According to the current App setting, when Auto Power Off is enabled, DWARF 3 powers off after about 15 minutes if it is not connected to the App and no shooting or processing task is running. Turning this setting off prevents that ordinary idle power-off behavior.

Do not confuse Auto Power Off with Sleep Mode. For a device that was not physically powered off and whose controller remained active, waking from sleep recalculates the current time using the sleep duration before the device evaluates upcoming scheduled tasks.

## 3.9 Astro Mosaic

DWARF 3’s astronomical mosaic feature allows you to capture and stitch together multiple adjacent fields of view, creating a wider and more detailed image of the night sky. It’s perfect for photographing large deep-sky objects such as the Orion Nebula and North America Nebula.

### **3.9.1 Mosaic Field-of-View:**

The DWARF 3 supports a maximum 1.8x1.8 zoom perspective. When shooting, DWARF 3 will automatically determine how many segments to shoot based on your selected composition ratio:

  * The default view is **1 × 1** , meaning only one segment is captured (no mosaic needed).

  * If **either** the horizontal or vertical composition ratio is greater than 1, that direction will use **2 segments**.

  * For example, a ratio of **1 × 1.5** results in **2views** , while **1.5 × 1.5** results in **4views**.

  * **Maximum supported layout:** 1.8 × 1.8, totaling **4 views**.

### 3.9.2 How long does it take to shoot the mosaic?

The estimated shooting time is automatically calculated based on your selected composition size, exposure time, and number of frames.

So for a full 1.8 × 1.8 mosaic (4 views), with 15s expo and 50 frames setting for each view, the estimated time is: 

**15s × 50 frames × 4 views = 50 minutes**

You can also customize the exposure and frame count, and the system will recalculate the estimated duration in real time.

**Tips:** If you haven't adjusted the parameters, the system will use the **default** settings:

  * **15-second exposure per frame**
  * **50 frames**

If you haven't adjusted the frame as well, the system will use the **default** settings:（15s X 999 ≈ 4h9min）

### 

### **3.9.3 How to use the mosaic function?**

##### 3.9.3.1 Enable Equatorial (EQ) Mode

Astronomical mosaics require stable tracking. To avoid image rotation caused by Earth’s rotation, EQ mode **must** be enabled for this function.

**Tip:** After EQ calibration, the preview frame will display real-time pointing direction. (Detail explanation later)

##### 3.9.3.2 Compose in Sky Atlas & Select Target

  * Choose your target in the Sky Atlas and adjust the preview frame.
  * Tap**GoTo** to locate the target.

**Tips:**

  * Recommended: Orion Nebula, North America Nebula, Vega’s surrounding star fields
  * Not Applicable: Moon, planets, comets — small or fast-moving objects

### 3.9.4 Set Shooting Parameters

After GoTo is complete, go to:

**Shooting Interface → Function → Parameter  **

Here you can customize:

  * **Exposure time**
  * **Gain**
  * **Number of frames**

You’ll also see the estimated total shooting time on this screen.

### 3.9.5 Auto Stitching & Post-Processing

After shooting, DWARF will automatically generate a **roughly preview** mosaic image.

We strongly recommend finish your mosaic image using **Stellar Studio** , which can intelligently detect and eliminate edge seams between Mosaic Views.

Go to: **Album → Stellar Studio** to post-process and optimize the final result！

If you notice obvious**light seams or edge discoloration** , it’s recommended to **manually review and filter the bad sub-frames** , then **restack in Mega Stack** before final processing in **Stellar Studio**.

### 3.9.6 Notes for Mosaic Rotation

If your DWARF 3 is placed flat on the ground (in Alt-Az mode), the preview frame will always be in a**horizontal** position.

**After setting up the equatorial** mode, the actual astronomical image will also be **tilted.**

The rotation angle**cannot** be manually adjusted; after all, DWARF 3 cannot yet assume a tilted position like a robot. However, it can calculate the angle through **calibration** (angle calculation in equatorial mode or calibration in GoTo).

**Recomended Astro Mosaic Workflow**

  * Set **EQ Mode**

  * Open the **Atlas** and use the **preview frame** to compose your mosaic (adjust position and size)

  * **Capture** the data

  * **Process in Stellar Studio**

> **Astro Mosaic Notes & Best Practices**
> 
>   * The **wide-angle camera** may support mosaic mode in a future update, but it’s not there yet.
> 
>   * Mosaic imaging is _far less forgiving_ than single-frame shots. Stitching quality lives or dies on capture quality.
> 
> 

> 
> To avoid ugly seams and artifacts:
> 
>   * Get your **EQ alignment as close to 0 deviation** before you start.
> 
>   * If seams show up, **re-shoot dark frames** and **reject low-quality subs**.
> 
>   * Restack your single session by using **Mega Stack** , then process your completed session in **Stellar Studio** for the final results!
> 
> 

As an official **DWARF 3 Product Expert** , here’s one thing to keep in mind before you embark on your next cosmic adventure:

The **DWARF 3** can take you light-years away—revealing distant stars, nebulae, and the quiet wonders of the universe—but let’s be clear: it won’t find your missing remote or untangle your love life. Even space tech has limits.

That said, when you look up at the night sky, remember that some of the most meaningful discoveries aren’t light-years away—they’re right beside you. Use the DWARF 3 to slow down, explore, and uncover both cosmic secrets _and_ the small joys hidden in everyday life. Every session has the potential to be memorable if you let it.

So here’s to turning every glance at the stars into a journey worth remembering.  
And if this helped you at all, give it a 👍 and carve out some time for your next adventure with DWARF 3. The universe isn’t going to explore itself. 🌌🔭
