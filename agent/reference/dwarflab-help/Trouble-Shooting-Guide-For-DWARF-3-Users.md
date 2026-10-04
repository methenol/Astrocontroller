# FAQ & Troubleshooting Guide for DWARF Users | DWARFLAB Help Center

Source: https://help.dwarflab.com/en/docs/Trouble-Shooting-Guide-For-DWARF-3-Users?product=dwarf-3
Saved: 2026-10-03 (official DWARFLAB Help Center, copied for offline reference)

## FAQ & Troubleshooting Guide for DWARF Users

Last updated

2026-08-13

Total words

71352 words

Estimated reading

60 minutes

Download PDF

There are two sections below to assist you in answering many questions that "frequently" come up on our social media pages. Additionally, we have tried to include many suggested methods and processes to resolve issues you find when using your DWARF. We may not be able to cover them all, but when there is doubt, please email or message us directly through any of our social media connections.

 

**FAQ** \- We’re here to help! You have questions, we may have answers! Check out our FAQ section to answer those commonly asked items.

 

**Troubleshooting** \- If you encounter any issues with your DWARF, try the steps below to resolve them. If the issue continues, feel free to contact us—we’ll be happy to assist you.

 

# 1\. Frequently Asked Questions (FAQ's)

### **Q: Can it capture Jupiter / Saturn?**

**A:** Yes — but with **significant limitations**. DWARF 3 is not designed or optimized for planetary imaging. Its small aperture and imaging system are intended for wide-field and deep-sky targets, not high-resolution planetary detail.

You can expect Jupiter and Saturn to appear primarily as **bright points or very small disks** , with limited color information. Under good conditions, you may see **Jupiter’s larger moons as separate points of light** , and in rare cases Saturn’s rings may be faintly suggested, but not resolved with detail.

That said, experimentation is encouraged. Many users continue to push the device creatively and capture results that exceed expectations within these constraints.

SaturnJupiter

  * ### **Q: What can I capture when looking at the Sun?**

A: This is more like what you won't see: prominences or flares. When you're looking at the sun, you can most definitely pick up sun spots, and maybe a faint appearance of granulation, but you wont get any specific detail as it gets a bit pixelated at a point in the imaging.

  * ### **Q: Can I capture Aurora Borealis (Northern Lights)?**

A: Yes....but with limitations. You ideally want a strong KP rating, 5-6 or higher for starters. The DWARF is not optimized for real-time video of Auroras for one. There is no Auto Setting (currently) or written procedure as capturing Aurora's is not a primary or secondary function of the device. You'll have to shoot in manual mode, wide-lens, and low exposure (1-5 seconds). Use burst or time-lapse to capture motion. Although we are biased towards our capable Astro devices, you may have a far better experience using a current cell phone camera or "GoPro" type of device for those magnificent space weather events.

### **Q: Do I need a live internet or cellular connection to use it?**

**A:** No. DWARF does _not_ require a live internet or cellular connection for normal operation. You only need to connect your phone or tablet to DWARF’s built-in Wi-Fi (hotspot).

An internet connection is only required for the following:

    * Initial device setup and activation

    * Downloading or updating the Atlas catalog in the DWARFLAB app

    * Performing firmware updates

    * Uploading or downloading images using Stellar Studio or Pano-Weave

If your phone or tablet does not have cellular or internet access, it may fail to automatically determine your location. Accurate location data is important for proper calibration and EQ plate solving.

To address this, the app allows you to manually enter your location, ensuring DWARF can accurately calibrate and plate-solve the sky above it.

For step-by-step details, refer to the DWARF User Guide.

### **Q: Can I use other filters with the DWARF ?**

**A:** No — not directly. Your DWARF does not have a built-in filter holder like the DWARF 2, nor does it support attaching standard 2-inch filters to the exterior of the lens or body. Internal filters also cannot be removed or replaced.

If you want to use additional filters, you’ll need a DIY (do-it-yourself) solution, such as a custom 3D-printed filter holder or another third-party mounting method attached to the lens area.

### **Q: Can I use third-party apps like Stellarium to connect with or control the DWARF ?**

A: No — it’s a closed ecosystem. You must use DWARFLAB’s own app and interface. There are many other "star" apps that are excellent and complementary to the DWARF 's function. They may help you plan out sessions, forecast weather or cloud cover and find specific RA/DEC coordinates for an object that we may not list or have updated in Atlas.

### **Q: If I need to enter manual coordinates for an object or DSO, what coordinates should I use?**

**A:** Use **J2000 coordinates**. J2000 is the current standard reference epoch used for astronomical coordinates and is the most reliable choice for manual entry.

For example, in "Stellarium", select your target, open the information panel at the bottom, then swipe to the next data set to view the J2000 coordinates. Other astronomy and night-sky apps often provide J2000 coordinates as well—just ensure you’re using that reference frame.

### **Q: Is there any lens fogging, dew, or moisture build up like the DWARF 2?**

**A:** The lens area was redesigned to direct internal heat toward the optics, significantly reducing the chance of moisture or dew forming. While no system is completely foolproof, there have been no widespread or consistent reports of fogging or moisture issues affecting user sessions under normal operating conditions.

### Q: What IP rating does the DWARF device have?

A: The DWARF has an **IP54** weather-resistance rating. That means it's designed to withstand dust ingress and splashes of water/moisture, plus dew, so you can use it outdoors in typical night conditions without worrying about a bit of dust or light moisture getting into the optics or electronics.

### **Q: What is the BAYER Array of the DWARF?  **

A: DWARF uses an **_RGGB BAYER Array._** This color filter array designation is helpful for individuals who do post-processing in applications or programs that require this information.

### **Q: Does the DWARF use "dithering"?**

**A:** Yes. DWARF performs **automatic dithering** during astrophotography captures.

For exposure times **under 60 seconds** , DWARF dithers after every **6 captured frames** (the 7th frame is used for dithering).  
For exposure times **of 60 seconds or longer,** DWARF dithers after every **10 captured frames** (the 11th frame is used for dithering).

Frames captured during the dithering movement are **intentionally discarded** and are not saved to the device. If you review your session files on a PC or Mac and notice skipped frame numbers or fewer saved images than expected, this is normal behavior and indicates that dithering was applied.

### **Q: Can the DWARF use an external storage connected directly to it (via USB-C)?**

**A:** No. DWARF does not support direct external storage (such as USB flash drives or SSDs) over its USB-C port. All captured photos and videos are saved to the device’s **internal 128 GB eMMC storage**.

Approximately **100–110 GB** of that space is available for user files; the remainder is reserved for the operating system and firmware updates.

To back up or transfer your data, connect DWARF to a **PC or laptop via USB-C**. In some cases, compatible phones or tablets may also be used. File transfers can also be performed via **FTP** if needed. Refer to the DWARF User Guide(s) for more information on how to transfer files or folders.

### **Q: How large can I print photos taken with the DWARF ?**

A: The images produced have a **DPI of 72 pixels/inch**. The maximum print size depends on your chosen printing method and materials, so we recommend consulting your printing service for the best results. Many users of the community have printed wonderful images. Do explore our social media pages for examples and suggestions.

### **Q: Do you have a process to accept community feedback; if we wanted to request a new feature or ask why something works a certain way?**

A: Yes, we have a website setup for this very process: https://a.c1ns.cn/y52Ny

### **Q: How can I access the DWARF 3 & Mini live video stream (RTSP / HTTP)?**

A: You can use a third party live streaming or video player app (such as VLC, OBS, etc.) to directly access the video streams from DWARF. It will only display the video stream, meaning it has no graphic overlay, no interface or other items commonly seen while viewing through the DWARFLAB app.

**> >Notes to ensure success!<<**

  * Make sure all devices (phone or tablet, PC and Dwarf device) are on the **same network**.

  * When STA mode is enabled, the DWARF's IP address will change; it can be found in Settings > My Device > IP Address (usually 192.168.XX.XX unless you have it assigned another custom IP address by your network)

  * You must "**start** " the live view on your DWARFLAB app by selecting LIVE and display the camera view on your app screen; this will allow the remote viewing app on your PC to connect to either lens view

  * Enter the network video stream address (as shown in the next section for each lens and function)

  * Some streaming apps or programs may require you to manually enter the stream URL.

  * Network performance may vary depending on connection type and signal strength of your devices and network.

 

  1. **When Using STA mode**

When STA mode is enabled, **you must replace 192.168.88.1 with the actual IP address assigned to DWARF by your home network / router**.

For example:
    
    
    rtsp://<DWARF3_STA_IP>/ch1/stream0

Example: VLC Media Player - entering video stream addressExample: Wide-Angle View (indicated by > /ch1/stream0)

  2. **Live video streams (RTSP)**

These RTSP streams provide real time video output from each camera lens. Be mindful that it will **STOP** providing real time video output when you "start" an Astro session. To view real-time stacking, use the HTTP address listed in the next section.
    
    
    rtsp://192.168.88.1/ch0/stream0
    
    
    rtsp://192.168.88.1/ch1/stream0

  3. **Astro stacking stream (HTTP)**

When performing an astrophotography stacking session, you can access the stacking video stream via:
    
    
    http://192.168.88.1:8092/mainstream

This stream is mainly used for monitoring the live stacking process via the tele-photo lens only. You may have to periodically stop and restart the media player connection to have the most current view of the live stack in progress.

Example: make sure you enter http:// first, then your stream IP addressExample: Live session performing a Deep Sky stacking of Pleiades / M45

## 2. 

# Troubleshooting

Here are some common problems and how to address them:

  * **Connection issues** (e.g., device not connecting to the app or network)

  * **Camera freezing or not working** (e.g., stuck during shooting or image stacking)

  * **Abnormal photos** (e.g., blurry, distorted, or dark images)

**Step 1: Log File Upload**

To help us identify the root cause of the issue, please upload your log files. The logs contain technical details that are crucial for troubleshooting.

How to Upload Log Files:

1\. Open the DWARF App.

2\. Navigate to the Settings section.

3\. Select Upload Logs.

4\. Follow the instructions to complete the log upload.

Even if you are experiencing connection problems, you should still be able to upload the log files. If the problem persists, try uploading a screen recording showing the failed connection or any error messages.

**Step 2: Provide Additional Information**

Along with the logs, it’s helpful for us to have visual evidence of the issue. Please attach the following:

• Photos or videos of the problem: If the issue involves image quality or capture problems, please share any photos or videos demonstrating the issue.

• Description of the steps leading to the problem: Include details about what actions you were taking when the problem occurred (e.g., trying to connect, shooting a specific target, adjusting focus).

**Step 3: Contact Support**

Once you’ve uploaded the logs and gathered relevant photos or videos, please contact our support team. Provide as much detail as possible about the problem, including:

• The model of your device (e.g., DWARF )

• The firmware version you are using

• A description of the issue (connection problem, stuck during shooting, abnormal photos, etc.)

• Confirmation that logs and visuals have been uploaded

You can reach out to us via the support section in the app or by emailing our support team at support@dwarflab.com.

## **2.1 Firmware Update Failed or Cannot Connect After Update**

If your DWARF fails to update the firmware or becomes **unreachable after a firmware update** , it might be due to an **interrupted update** , **power fluctuation** , or **incomplete installation**. **Please contact us immediately at**[**hello@dwarflab.com**](mailto:hello@dwarflab.com)

## 2.2 **Activation Failure**

If you’re having trouble activating your DWARF, please follow these steps:

  1. Please uninstall the current App and download the latest DWARFLAB App from the App Store (_make sure it’s not the BETA application version_).

  2. If you are using a device, such as a tablet, with no active internet connection, then after connecting to DWARF , go to **Settings > My Device > STA**, and finish the STA connection. This will allow you to use the DWARFLAB App while staying connected to your home WiFi. Activation requires an **internet connection**.

If you are using a cellular enabled device, please ensure your phone (or celluar enabled tablet) is connected to the internet before proceeding with activation.

  3. Try activating the device again. **Make sure to turn off any VPN!**

  4. If activation fails again, please:

     1. Upload the log via **DWARFLAB App > Settings > Support > Log Upload**.

     2. Send us the **SN (serial number)** located at the bottom of your DWARF .

     3. Share the failure message or prompt with us.

     4. Contact us at **support@dwarflab.com** with details about the problem, including any error messages you’ve received.

## 2.3 Connection & Activation Failure Error Code

This is completely normal! In **Astronomy Mode** , the LED light automatically turns red to reduce light pollution during observation. Additionally, when the battery is low and the device is about to shut down, the ring light will also turn red.

## 2.5 **What should I do if my DWARF fails to connect in Auto Mode?**

If you’re experiencing connection issues in Auto Mode, please do the following:

  * Make sure any **VPN and/or Anti-Virus applications are turned OFF or paused**.

  * For **iOS/iPad OS Devices** : Try the following steps to reconnect to your DWARF using a normal connection

Open Settings > Wi-Fi > select Edit > Under your **"Known Networks"** , find the DWARF devices network profile (example: it will be DWARF_XXXXX or other custom name you created) > either select the red icon and select **DELETE** , or press the info icon on the right side of the name, then select **Forget This Network** , located at the top of the screen. This will remove the saved profile

  * For **Android Device(s):** Try the following steps to reconnect to your DWARF using a normal connection. (methods or processes may vary from model/device or Android OS)

Open Settings > Connections > Wi-Fi > locate the option for**"Advanced Settings"**(or similar selection) > Manage Networks > find the DWARF devices saved network profile (example: it will be DWARF_XXXXX or other custom name you created) > select the saved profile name > at the bottom, select "**REMOVE** " or "**FORGET** " to delete the saved profile.

After you have completed the previously suggested steps for the phone or tablet device, open the **DWARFLAB** application, go to Settings, then open Connection Settings. Verify all settings are turned off (Enable 2.4 Ghz, Wi-Fi Compatible Mode, etc). Go back to the **HOME** page, then press **CONNECT** to find your DWARF device through the normal connection process. If you still continue to have difficulties connecting your phone or tablet to your DWARF, then continue on to the next troubleshooting step below to report your log and contact our support team.

  * Open the **DWARFLAB app** and go to **Settings → Support → Log Upload** to upload your log files. Give a brief description of the connection issue. (you can do this even if the DWARF device is not connected).

  * Contact us at **support@dwarflab.com** with details about the issue. The following information will help us resolve it faster:

• Can you see the DWARF’s Wi-Fi/Bluetooth name in your phone/tablet’s system settings?

• Can you find the DWARF in your Wi-Fi list and manually connect using **DWARF_12345678**?

• Did the connection issue suddenly appear, or has it existed since you first received the device?

## 2.6 **What should I do if DWARF fails to connect in AP or STA Mode?**

First, try switching between both connections manually.

**AP Mode will be a direct connection to the DWARF hotspot**

  * Are you too far from the DWARF?

  * Is there any physical object or electrical interference?

  * Multiple wireless devices in close proximity?

  * Is your phone or tablet updated to its latest operating system?

  * Are you using the DWARF device in temperatures outside its recommended operating range?

**STA Mode will use your home or public Wi-Fi connection**

  * Is your DWARF positioned too far from the Wi-Fi access point?

  * Does the Wi-Fi access point require special privileges or a feature enabled?

  * Are you using a "mesh" network that has multiple Wi-Fi access points?

*Attempt to setup STA mode while close to the Wi-Fi access point positioned best to connect to your DWARF device

  * Are the access point name and password entered correctly?

If you’ve ruled out these possibilities and still cannot connect, please upload your log files via **Settings > Support > Log Upload** and contact us at **support@dwarflab.com**.

For more details on **connection settings** , check our help page: [DWARF 3 - User Guide – 1.1.6 Connect](https://help.dwarflab.com/en/docs/DWARF-3-Smart-Telescope-User-Manual-Part1-App-Interface-Introduction?product=dwarf-3#1-1-6-connect)

### 2.7 **Device Won’t Power On or Charge**

If your DWARF isn’t turning on or charging, please try the following:

1\. **Use a different charger and cable** to see if the issue persists. We recommend using a **10W or higher** rated cable and charger.

2\. If changing the charger and cable doesn’t help, please email **support@dwarflab.com** with a short video showing:

• The specifications printed on your charger.

• The charging cable plugged into the DWARF , along with the side LED indicator.

### 2.8 **My computer asks me to format the DWARF 3’s storage / I can’t download photos from the album**

If you encounter this issue, please contact **support@dwarflab.com**. We will schedule a remote session to assist you in resolving the problem. We also suggest trying another USB-C Cable to see if that resolves the connection issue as well and seeing if you can replicate the problem on another PC or Laptop device. It may simply be a USB driver missing from your computer which doesn't allow the connection, or in some cases, virus software or security settings blocking it.

### 2.9 **Issues with Image Quality or Stacking Failures**

Stacking may fail due to the following reasons:

1\. **Over-exposure** : The background is too bright. Try reducing the gain. _(Note: Stacking may fail in areas with high light pollution, such as high Bortle levels.)_

2\. **Misfocus** : Stars appear distorted or not round due to improper focus.

3\. **Unstable tracking** : Star trails instead of round stars caused by tracking instability.

4.**Dark frames:** Contain streaks or trails, or they were not taken in complete darkness.

⚠️ Note: if stacking fails at the very start, this is most likely due to incorrect dark frames or improper calibration/tracking

5\. **External factors** : Wind or an unstable tripod can cause stars to appear distorted or elongated.

### If you notice issues with your images or stacking fails:

1\. **Locate the unstacked photos** :

  * Connect DWARF to your phone/PC via a USB-C cable.

  * Look for the **"DWARF_RAW"** folder and locate the affected photos.

2\. **Share the files with us** :

  * Upload the unstacked photos via **Google Drive** or **WeTransfer**.

  * Share the viewing permissions with [**hello@dwarflab.com**](mailto:hello@dwarflab.com) and [**sm3muzi@gmail.com**](mailto:sm3muzi@gmail.com).

  * Include the sharing link in your response.

### How to improve stacking results:

The automatic stacking feature activates when the camera detects celestial objects. To ensure successful stacking, follow these steps:

1\. **Shoot a starry sky** : Ensure stars are visible and unobstructed. Stacking will fail if stars are blocked by clouds or obstacles.

2\. **Focus properly** : Make sure the stars are sharp and round.

3\. **Avoid overexposure** : Reduce the gain if the image is too bright.

4\. **Wait for stable tracking** : After using GoTo, wait 30 seconds for stable tracking. Stacking may fail if stars have trails due to unstable tracking, wind, or vibrations.

5.**Delete the problematic dark frames** and re-shoot them properly — **make sure the lens is fully covered and no light enters.**

### **2.10 Tele Photo and Wide-Angle Views Do Not Align**

If the wide-angle and telephoto views are misaligned, point DWARF mini at a distant object (at least 200m away) in ****General Mode**** , then select "****Align Green Frame**** " under ****Parameters > Settings****.

### **2.11 Focus Not Right (Value Not Displayed)**

When entering _Photo mode_ , the focus value does not appear, and the image remains out of focus. This issue is often software-related and occurs when the focus motor fails to retrieve a focus position.

#### **Step-by-Step Solution**

  1. **Connect to DWARF 3**
  2. Make sure your mobile device is connected to the telescope and launch the DWARFLAB App.
  3. **Enter Photo Mode**
  4. From the home screen, go to **Photo Mode**.

  5. **Adjust Lens Position**
  6. Move the telescope so that the **telephoto lens** is pointed at a **bright object approximately 5 meters away**.

  7. **Manually Adjust Focus**

  * Tap the **Focus** button.

  * Use the **\+ / –** buttons to manually adjust the focus until the image becomes clear.

  * Once the image sharpens, the **focus value should reappear**.

  8. **Use Auto Focus for Distant Objects**

  * Now point the telephoto lens at an object **more than 5 meters away**.

  * Tap **Auto Focus**.

  * Fine-tune the result manually if needed.

  9. **Save Focus Settings in Astro Mode**

  * Switch to **Astro Mode**.

  * Tap **Function** → scroll to **Manual Adjust Focus** → tap **Update** to save the focus settings.

### 2.12 **Color Swirls or Colored Borders in Stacked Images**

If your stacked image shows **colored edges** , **RGB fringing** , or a **swirled/vortex-like filed rotation pattern** , this usually indicates that **some frames affected by light pollution or inconsistent brightness** were included in the stacking process.

#### **Possible Cause**

When a frame with **light pollution** , **lens flare** , or significant brightness shift is included in the stacking, it can distort the alignment and create edge artifacts or color distortions.

#### **How to Fix It**

  1. **Go to the Album**

  2. Open the DWARFLAB App and tap **Album** at the bottom.

  3. **Enter Mega Stack, Open the Folder for the Problem Image and Select View Single Frames**

  4. Go through the individual frames and **uncheck any that are overexposed, discolored, affected by light pollution, or clearly misaligned**.

  5. **Tap “Megastack”**

  6. **Re-stack the Clean Frames**

#### **Tips**

  * Common causes include outdoor lights, moonlight, or daytime reflections entering the frame.

### **2.13 Colored Stripes, Dotted Noise, or Black Artifacts in Your Photos?**

If your stacked astrophotos show **colorful streaks** , **spotty artifacts** , or **black line patterns** , this is often caused by a **mismatch between the ambient temperature and your existing dark frames**.

The **dark frame** (used to subtract sensor noise) is sensitive to **temperature changes**.

If the environment has changed significantly since you last took your darks — especially if the temperature is higher or lower — the dark subtraction becomes inaccurate, and residual noise patterns can appear in the final image.

#### **What To Do?**

In this case, **please retake your dark frames at the appropriate settings** :

  1. **Go to the Astro Mode - “Function-Darks”** in the DWARFLAB App.

  2. **Cover the lenses using the solar filter** (or take the darks in a fully dark environment).

  3. **Ensure the device has stabilized at the current ambient temperature** before capturing.

  4. Retake the dark frames for both wide and telephoto lenses if needed.
  5. To fix image sessions with the issues identified in the example pictures above, use the **MEGASTACK** function and the "new" darks you captured (as long as they are similar to your image settings) will be used for the re-stacking and should resolve the visual issue.

> **Special Occasion: If** you notice **black stripes** in your processed images, this usually means that there was**light leakage during dark frame capture.** Please follow these steps to fix the issue: 

### **Step 1: Delete the old dark frame file**

  1. Connect your DWARF and navigate to the storage path:

`DWARF3\CALI_FRAME\dark\cam_0`

  2. Find the dark frame file that matches the **same exposure time and gain** as your captured images.

`dark_exp_15.000000_gain_60_bin_1_9C_stack_7.fits`

  3. **Delete this file.**

> **Note:** The darks that need to be deleted are the stacked calibration frames in **CALI_FRAME** , since bad darks in **Astronomy\DWARF_DARK** are only used once to build the calibration frame and won’t affect future stacking.

### **Step 2: Capture a new dark frame**

  1. Use the **same exposure time and gain** as your original capture.

  2. Try to keep the **temperature as close as possible** to the original capture.

### **Step 3: Re-stack with Mega Stack**

  1. Use **Mega Stack** to re-stack your data like the instructions said above.

  2. DWARF 3 will automatically apply the newly captured dark frame.

> ### **Notes**
> 
>   * Make sure the dark frame is captured in complete darkness to avoid any light leakage.
>   * Exposure time and gain must match your actual capture, otherwise the dark frame won’t apply correctly.
> 

### **2.14  Strange Square Artifact in the Stacked Image.**

This effect is usually caused by issues during stacking, such as target drift or instability in the setup. Possible reasons include:

  1. **Target drift or misalignment**

The telescope may have slowly drifted off the target during capture.

  2. **Obstruction or corrupted frames**

Sometimes the stacking “catches” an obstruction or includes single frames with drifted stars (to the left or right).

#### **How to fix it?**

  * Try re-stacking the original FITS files using **Mega Stack**.

  * Check the individual subframes in your album. Delete those with drift or artifacts, then restack the remaining frames. It may recover a more usable area and re-center the target in the final stacked image.
  * If the issue persists, you may need to reshoot the session with a more stable tripod and careful alignment.

### **2.15 Stellar Studio Upload Takes a Long Time and Then Fails**

If you see the error **“upload failed”** , it is usually caused by an **unstable network connection**. Here’s what you can try:

  1. **Finish your capture session first**
  2. **Switch to STA mode**

After finishing, connect your DWARF device to a **stable home Wi-Fi network** in STA mode.

  3. **Choose a strong and reliable signal**

  * Uploading from a location with strong Wi-Fi (such as your home network) will make the process much more stable.
  * Many users in the community have reported that this greatly improves upload speed and reliability.
  * If you continue to have an "upload failed" message, our cloud services may be down. Please wait for a period of time and try again. Check our social media pages for any notifications or updates of disrupted services. We intend on adding a cloud service status notification in the Dwarflab application at a future date.

## 2.16 **Astro Photos Not Showing in Your Album**

**Issue cause:**

If the device shut down unexpectedly during shooting (or you forgot to press stop button and shut down the device directly), the system may fail to generate the final stacked image, causing the photo not to appear in the in-app gallery. (But files are existing in DWARF drive)

Follow the steps below to restore your image display.

**1\. Power on your D3 and connect it to your computer using a USB data cable.**

**2\. Locate the target folder**

Open the D3 storage (USB drive) on your computer.

Go to the **Astronomy** folder.

Inside it, find the folder of the target object that failed to generate a final image.

You can identify it based on:

1\. Target name

2\. Exposure time and gain

3\. Shooting date and time

**3\. Add the missing required files**

Inside the target folder, you need to add the three required files.

**Step 1: Copy the following two JPG files from any normal, completed astronomy folder (to let the photo show up again in the album)**

  * stacked.jpg

  * stacked_thumbnail.jpg

**Step 2: Create a placeholder FITS file and rename it as a stacked file (to let the photo show up again in the album)**

From the broken folder, copy **any** FITS single frame and paste it again in the same folder.

Rename the copied file to:

**stacked-16_[target][parameters][mode]_[time].fits (to fool the device to think this is the missing file)**

📌 **Important:** Remove the temperature part from the filename. （Since Stacked files don't have temps）

Please refer to the following correct format.

**4\. Check the restored result**

Restart your D3 and reconnect using the App.

Open the Gallery and check whether the image now appears normally.

**5\. Re-stack your data using Mega Stack**

Once the file appears in your Gallery:

  * Open Mega Stack

  * Re-stack your FITS frames to generate a fresh real stacked image

  * You can then process it using PC software or Stellar Studio as usual

**Additional Notes**

  * Since the JPG and thumbnail are copied from another target, the restored item in the gallery will temporarily show the **wrong preview** (from the donor target), but this does not affect your FITS data or re-stacking.

  * If the image still does not appear, please ensure that **all three required files** have been added to the folder.

  * This fix doesn't apply to Astro mosaic sessions.
