# Get to Know the Files Stored in DWARF 3 | DWARFLAB Help Center

Source: https://help.dwarflab.com/en/docs/How-to-View-and-Obtain-the-Files-on-DWARF-3?product=dwarf-3
Saved: 2026-10-03 (official DWARFLAB Help Center, copied for offline reference)

## Get to Know the Files Stored in DWARF 3

Last updated

2026-08-22

Total words

40821 words

Estimated reading

35 minutes

Download PDF

Files in DWARF 3 can not only help you relive various moments of your observations but obtaining single-frame images for advanced post-processing is a significant milestone in your journey to becoming a mature astronomer! Without further ado, let's get started!

# 1\. How to Get Access to Files in DWARF 3

## 1.1 Connecting DWARF 3 to a Computer

Use a **USB-A to USB-C** or **USB-C to USB-C** cable to connect your DWARF device to your computer. The device will appear as a **USB storage drive** , allowing you to **copy, move, or edit files** stored on DWARF 3. This method works on both **Windows and macOS**.

> **File Access Notes:**
> 
>   * If you experience problems with your DWARF device connecting to your PC, Laptop or other compatible device, validate the USB cable you are using is data compatible. Try to use another cable, or verify your computers USB port is functioning correctly.
> 
>   * After connecting DWARF 3 to your computer, **newly captured files may not appear automatically**. To refresh the file list, **disconnect and reconnect** the device.
> 
>   * If needed, you can still **browse newly captured files wirelessly** during this time.
> 
>     * [[How to view DWARF 3 files wirelessly on a computer]](https://tinyphoton.feishu.cn/wiki/FCqPwCHAti8McqkAfawcbaTin1b?from=from_copylink)
> 
>   * **DWARF 3 does not support external storage devices** , such as USB flash drives or portable hard drives.
> 
>   * Some mobile devices that support **USB OTG (On-The-Go)** —including certain Android phones, iPhones, iPads, and tablets—can access DWARF’s storage. Using a **USB-C to USB-C cable** , you can browse, copy, and transfer files between the device and your mobile device. Examples are shown below.
> 
> 

## 1.2 USB OTG Connection (with mobile or tablet devices)

This is a **very useful option when you’re on the go** and don’t have access to a computer, or when you simply need to **free up space** on your DWARF device.

Using a **USB-C to USB-C data cable** (or **USB-C to Lightning** for some older Apple devices), you can connect your phone or tablet directly to the DWARF 3. When connected, the DWARF will appear as **external storage** , allowing you to **browse, copy, or delete files and folders** directly from your mobile device.

This works on both **Apple and Android** devices and is ideal for quick backups in the field. Below are two examples showing successful USB OTG connections on both **Apple** and **Android** devices.

Example: Apple Device (iPhone Files access - DWARF storage is labeled "untitled") 

Example: Android Device (Samsung File access - DWARF is labled "USB storage 1") 

## 1.3 Important note (don’t skip this)

If you back up or copy files using USB OTG, always delete the session afterward from within the DWARFLAB app using the Album → Delete option.  
This ensures all associated session folders and metadata are properly removed and prevents orphaned files from lingering on the device.

# 2\. Introduction to Files in DWARF 3

Open the "DWARF 3" storage drive, you will see Astronomy, Burst, Normal Photos, Panoramas, Videos, and some basic data folders (_not all folders shown below will apply unless detailed in this guide_).

## 2.1 Astronomy

Here, there are 5 types of folders: **CALI_FRAME, DWARF_DARK, DWARF_RAW,Solving_Failed** and **Restacked**. 

### 2.1.1 CALI_FRAME

The prebuilt（factory equipped） dark, bias, and flat files are stored in this folder.

>   * Within the **Bias** , **Dark** , and **Flat** directories, you’ll see two subfolders: **cam_0** and **cam_1**.
> 
>   * **cam_0** contains calibration frames captured by the **telephoto camera**
> 
>   * **cam_1** contains calibration frames captured by the **wide-angle camera**
> 
>   * This separation is intentional. Each camera has different optics and sensor characteristics, so their calibration data **must remain separate** for proper image correction.
> 
> 

#### 2.1.1.1 Dark Frames

Naming format based on data interpretation of telephoto dark field, as follows:

> Take `**dark_exp_15.000000_gain_60_bin_1_38C_stack_10.png**` as an example:
> 
>   * **exp_15.000000** → exposure time of **15 seconds**
> 
>   * **gain_60** → gain value set to **60**
> 
>   * **bin_1** → binning mode
> 
>     * For the **telephoto camera** :
> 
>       * `bin_1` = **4K resolution**
> 
>       * `bin_2` = **2K resolution**
> 
>   * **38C** → dark frame temperature of **38 °C**
> 
>   * **stack_10** → dark frame created by **averaging 10 individual dark frames**
> 
> 

> **Note:** Any additional dark frames you capture with the same settings will be **stacked into this file** and stored in this directory for use during image stacking.
> 
> **Bottom line:** the filename fully describes the capture conditions, and matching those parameters is critical for proper calibration.

#### 2.1.1.2 Flat Frames

The data of telephoto flat field is as follows:

>   * **flat** → flat frame
>   * **gain_2** → gain value set to **2**
>   * **bin_1** → binning mode
>     * For the **telephoto camera** :
>       * `bin_1` = **no binning (4K resolution)**
>       * `bin_2` = **2×2 binning (1080p resolution)**
>     * For the **wide-angle camera** :
>       * `bin_1` = **no binning (1080p resolution)**
>   * **ir** → filter setting
>     * `0` = **standard filter**
>     * `1` = **astronomy filter**
>     * `2` = **dual-band filter**
> 

#### 2.1.1.3 Bias Frames

The name of the bias field is telephoto and wide angle `bias_gain_2_bin_1`

### 2.1.2 DWARF_DARK

> Your **self-captured individual dark frames** are here. However, the dark frames stacked using them for later shooting can still be found in the **Cali_Frame** section as mentioned earlier.

### 2.1.3 DWARF_RAW

Each astrophotography shooting session generates a **dedicated folder** that stores the captured **light frames** (raw files).

#### 2.1.3.1 DWARF_RAW folder naming

Light frame folders follow this format:

`**DWARF_RAW_TARGET_EXP_value_GAIN_value_TIME**`

Where **TIME** is recorded with **millisecond precision**.

> **Example**
> 
> `**DWARF_RAW_Sun_EXP_15_GAIN_30_2023-01-01-10-30-30-100**`
> 
> This indicates:
> 
>   * **TARGET** → Sun
> 
>   * **EXP_15** → 15-second exposure
> 
>   * **GAIN_30** → gain set to 30
> 
>   * **2023-01-01-10-30-30-100** → January 1, 2023 at 10:30:30 AM, **100 ms**
> 
> 

Each folder contains all light frames captured during that specific session using the same exposure and gain settings.

Accessing the light frames allows you to perform post-processing on your own or, when you're not satisfied with the stacked images, you can bundle this folder and send it to us for review!

#### 2.1.3.2 DWARF_RAW file Naming

Each folder contains individual raw files. The name of the respective single-frames inside this folder is:

> Each capture session includes metadata and output files containing the following information:
> 
>   * **Target name**
> 
>   * **Exposure and gain values**
> 
>   * **Filter used**
> 
>   * **Timestamp**
> 
>     * Format: `YYYY/MM/DD/HH/MM/SS/FFF`
> 
>     * Includes year, month, day, hour, minute, second, and millisecond
> 
>   * **Sensor temperature** (°C / °F)
> 
>   * **Rejected frames** (frames excluded during stacking)
> 
> 

> 
> In addition to the raw data, each session produces:
> 
>   * **8-bit stretched JPG (stacked)**
> 
>   This is the downloadable version on mobile devices
> 
>   * **16-bit non-linear PNG (stretched and stacked)**
> 
>   * **16-bit linear FITS file (single and stacked)**
> 
>   (Or **TIFF** , if selected in the app settings)
> 
>   * **Thumbnail files**
> 
> 

> 
> All folders also include files with the `**_thumbnail**` suffix.

### 

#### 2.1.3.3 Shotsinfo (JSON file)

A JSON file associated with astro images on the DWARF smart telescope is a metadata file containing technical data about an imaging session. It does not contain the image data itself, but rather the parameters of how the image was captured.

> **Key Information in**`**shotsInfo.json**`**File:**
> 
>   * **Coordinates:** Right Ascension (RA) and Declination (DEC) of the target.
> 
>   * **Camera Settings:** Binning (e.g., 1*1 _, 2*2_) and IR filter status.
> 
>   * **Exposure Details:** Exposure time per frame (e.g., 15 seconds) and gain settings.
> 
>   * **Format of primary file:** FITS or TIFF
> 
>   * **Temperature:** Sensor temperature, which is useful for calibration.
> 
>   * **Stacking Stats:** Number of frames taken vs. number of frames successfully stacked.
> 
>   * **Target:** The name of the celestial object being imaged.
> 
> 

> 
> **Purpose of the JSON File**
> 
>   * **Debugging Stacking Issues:** If photos fail to stack, this file helps determine if frames were overexposed or poorly focused.
> 
>   * **Post-Processing Data:** It provides essential information for processing FITS images in software like PixInsight or Siril.
> 
>   * **Session Tracking:** It accompanies individual sub-frames in a directory to provide a summary of the session.
> 
> 

### 

**Example of**`**shotsInfo.json**`**Content:**

### 2.1.4 Solving_Failed

When the classic "Calibration Failed" occurs, this folder is automatically created.

The naming convention for the Calibration Failed folder is _DWARF_CALIBRATION_TIME_(precise to millisecond)_.

Each folder includes all attempts made during this calibration failure.

When calibration failure happens, don't be upset or frustrated. First check if there are**clear** and properly **focused stars** in the images here. The image format is **JPG** , making it easy for you to review on your own. Alternatively, you can package it and send it to our experts to receive professional advice!

### 2.1.5 Restacked

**This section contains stacked images generated using the Mega Stack feature.** Each stacking session creates a new folder, and includes these formats: PNG, FITS JPG and thumbnails.

## 

### 2.1.6 STARTRAILS

This folder stores all files generated when using the Star Trails feature.

Each time a star trail stacking process is completed, the system automatically creates a new folder. The folder contains the following items:

  * **Thumbnail folder** : Stores preview images for quick viewing.

  * **shotsInfo.json file** : Records the shooting parameters and stacking information for this session.

  * **Stacked image files (JPG / PNG / FITS)** : The final star trail image generated after stacking.

  * **Individual FITS files** : The original exposure data captured during the shooting process.

  * **MP4 video file** : A star trail video generated from the sequence of captured exposure frames.

## 2.2 Burst

This folder contains your burst photos, perfect for capturing fast-moving subjects or creating a series of images to be compiled into animations or high-dynamic range (HDR) photos.

In burst mode, you can use both the telephoto and wide-angle lenses to capture shots. With the previous explanations, the naming convention here becomes self-explanatory: _DWARF_WIDE_TIME and DWARF_TELE_TIME_. I'll save my tongue.

## 2.3 Normal Photos

The naming convention for this folder is completely consistent.For your convenience, we have placed all the unnecessary thumbnails in one folder.

## 2.4 Panoramas

The DWARF_PANORAMA_TIME files are the panoramic photos you've captured. Take them to pro software to stitch them into large panoramic images! Alternatively, you can look forward to our upcoming automatic stitching feature. Simply package the folder, upload it, and it'll return a beautifully stitched piece of art to you!

> Pano Note:
> 
> Panorama folders contain **sequentially captured images** , with filenames numbered according to the **order in which they were taken**.
> 
> You may notice that numbering starts at **0 rather than 1**. This applies to panorama images **and astro FITS files** as well. This is standard **zero-based indexing** , a common convention in programming.
> 
> Nothing is missing, and no frames are skipped — it’s just a coding rule, even if it looks a little weird at first.

## 2.5 Videos

Just like in your App album, the contents of the Videos folders are divided into two categories: videos shot in Video Mode and Time-Lapse Mode, each named with _DWARF_TELE_TIME_ and _DWARF_TELE_TL_TIME_ , respectively.

# 3\.  Manually Manage the Files (Deletion and Format)

You can connect the DWARF 3 to your computer to manage files, or directly delete the desired content**from the App album**.

### **3.1 How to DELETE files:**

  1. **Select the files or folders** you want to remove. Right-click and choose **Delete** , or drag them to the **Trash/Recycle Bin** , just like on a regular PC or Mac.

  2. **Empty the Trash/Recycle Bin** to permanently delete the files. (_This step is especially important on macOS._)

  3. **Reboot DWARF 3** (power off, then power on), reconnect to your PC or Mac, and verify that the available storage has updated.

> **Deletion Notes**
> 
>   * **iOS devices:** Deleting a file is usually a **two-step process** :
> 
>     * Delete the file from its folder.
> 
>     * Remove it from the **“Recently Deleted”** folder to permanently free storage.
> 
>   * **macOS devices:** Make sure to **empty the Trash** to complete the deletion process.
> 
>   * After following these steps, DWARF 3’s available storage should increase. If your storage does not update or you run into issues, contact **DWARFLAB** for assistance.
> 
> 

### **3.2 How to FORMAT the DWARF 3 internal storage:**

**Important:** Formatting will **_erase all data_** on your DWARF device. Make sure to **back up any files** before proceeding.

  1. **Connect DWARF 3 to your computer** using a **USB-C to USB-C** or **USB-A to USB-C** cable.

  2. **Power on DWARF 3**. It should appear as a **drive/disk** on your computer.

  3. **Format the drive:**

     1. **Windows:** Right-click the DWARF 3 drive and select **Format**. _(Do not choose “Quick Format”)_

     2. **macOS:** Select the DWARF 3 drive and choose **Erase Disk**

  4. **Select exFAT** as the file system.

  5. **Verify storage:** After formatting, check the folder structure and available storage. You should see approximately **100-110 GB** available. _(Remaining space is reserved for the device’s OS and system functions.)_

  6. **Reconnect DWARF 3 to the DWARFLAB App** and start a session. Retake any necessary calibration files (dark frames)

  7. Optionally, reconnect DWARF 3 to your computer later to **verify that folders have been created** and your session data is saved.

> _**Formatting Notes:**_
> 
>   * Formatting the DWARF 3 will delete all folders, but they will be **automatically generated during the next shooting session.**
> 
>   * Do not worry about losing the calibration frames when formatting the internal storage. The factory calibration frames in **Cali_Frame (stacked Flat, Bias, Dark Frames)** will be automatically regenerated when the device restarts astro shooting.
> 
>   * If you are ONLY removing old session folders for the purposes of retaining storage space, it is highly suggested you _**do not deleteAstronomy- DWARF_DARK**_ folders. This will save time on having to re-do your processes for your single DARK calibration frames if you need them to process your images later on your own.
> 
> 

Alright, the above covers all the information about the internal storage files. If you find it helpful, don't forget to give it a thumbs up and schedule some time for post-processing!
