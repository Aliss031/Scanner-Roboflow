/*jshint esversion:6*/

$(function () {
    const { InferenceEngine, CVImage } = inferencejs;
    const inferEngine = new InferenceEngine();

    const video = $("video")[0];

    var workerId;
    var cameraMode = "environment"; // or "user"

    const startVideoStreamPromise = navigator.mediaDevices
        .getUserMedia({ audio: false, video: { facingMode: cameraMode } })
        .then(function (stream) {
            return new Promise(function (resolve) {
                video.srcObject = stream;
                video.onloadeddata = function () {
                    video.play();
                    resolve();
                };
            });
        });

    const loadModelPromise = new Promise(function (resolve, reject) {
        inferEngine
            .startWorker("parcel_recipient_details", "3", "rf_Fmrqdci3JKREklTTJOfEyT2NCVF2")
            .then(function (id) {
                workerId = id;
                resolve();
            })
            .catch(reject);
    });

    Promise.all([startVideoStreamPromise, loadModelPromise]).then(function () {
        $("body").removeClass("loading");
        resizeCanvas();
        detectFrame();
    });

    var canvas, ctx;
    const font = "16px sans-serif";

    function videoDimensions(video) {
        // Ratio of the video's intrisic dimensions
        var videoRatio = video.videoWidth / video.videoHeight;

        // The width and height of the video element
        var width = video.offsetWidth,
            height = video.offsetHeight;

        // The ratio of the element's width to its height
        var elementRatio = width / height;

        // If the video element is short and wide
        if (elementRatio > videoRatio) {
            width = height * videoRatio;
        } else {
            // It must be tall and thin, or exactly equal to the original ratio
            height = width / videoRatio;
        }

        return { width: width, height: height };
    }

    $(window).resize(function () {
        resizeCanvas();
    });

    const resizeCanvas = function () {
        $("canvas").remove();

        canvas = $("<canvas/>");

        ctx = canvas[0].getContext("2d");

        var dimensions = videoDimensions(video);

        console.log(
            video.videoWidth,
            video.videoHeight,
            video.offsetWidth,
            video.offsetHeight,
            dimensions
        );

        canvas[0].width = video.videoWidth;
        canvas[0].height = video.videoHeight;

        canvas.css({
            width: dimensions.width,
            height: dimensions.height,
            left: ($(window).width() - dimensions.width) / 2,
            top: ($(window).height() - dimensions.height) / 2
        });

        $("body").append(canvas);
    };

    const renderPredictions = function (predictions) {
        var scale = 1;

        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);

        predictions.forEach(function (prediction) {
            const x = prediction.bbox.x;
            const y = prediction.bbox.y;

            const width = prediction.bbox.width;
            const height = prediction.bbox.height;

            // Draw the bounding box.
            ctx.strokeStyle = prediction.color;
            ctx.lineWidth = 4;
            ctx.strokeRect(
                (x - width / 2) / scale,
                (y - height / 2) / scale,
                width / scale,
                height / scale
            );

            // Draw the label background.
            ctx.fillStyle = prediction.color;
            const textWidth = ctx.measureText(prediction.class).width;
            const textHeight = parseInt(font, 10); // base 10
            ctx.fillRect(
                (x - width / 2) / scale,
                (y - height / 2) / scale,
                textWidth + 8,
                textHeight + 4
            );
        });

        predictions.forEach(function (prediction) {
            const x = prediction.bbox.x;
            const y = prediction.bbox.y;

            const width = prediction.bbox.width;
            const height = prediction.bbox.height;

            // Draw the text last to ensure it's on top.
            ctx.font = font;
            ctx.textBaseline = "top";
            ctx.fillStyle = "#000000";
            ctx.fillText(
                prediction.class,
                (x - width / 2) / scale + 4,
                (y - height / 2) / scale + 1
            );
        });
    };

    var prevTime;
    var pastFrameTimes = [];
    var lastOCRTime = 0;
    var ocrThrottle = 3000; // Run OCR every 3 seconds to optimize performance
    var ocrWorker = null;
    var ocrInitialized = false;
    
    // Initialize Tesseract.js OCR worker with optimized settings
    function initializeOCR() {
        if (ocrInitialized) return;
        
        console.log('Initializing Tesseract.js OCR...');
        Tesseract.createWorker('eng', 1, {
            logger: function(m) {
                if (m.status === 'recognizing text') {
                    // Optionally show progress
                }
            }
        }).then(function(worker) {
            ocrWorker = worker;
            ocrInitialized = true;
            console.log('OCR initialized successfully');
        }).catch(function(err) {
            console.error('OCR initialization error:', err);
            ocrInitialized = false;
        });
    }
    
    // Initialize OCR when page loads
    initializeOCR();

    // Function to extract and preprocess image region from bounding box
    const extractImageRegion = function(prediction) {
        const x = Math.max(0, prediction.bbox.x - prediction.bbox.width / 2);
        const y = Math.max(0, prediction.bbox.y - prediction.bbox.height / 2);
        const width = Math.min(prediction.bbox.width, video.videoWidth - x);
        const height = Math.min(prediction.bbox.height, video.videoHeight - y);

        // Create a temporary canvas to extract the region
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        tempCanvas.width = width;
        tempCanvas.height = height;

        // Draw the region from the video onto the temp canvas
        tempCtx.drawImage(
            video,
            x, y,
            width, height,
            0, 0,
            width, height
        );

        // Image preprocessing to improve OCR accuracy
        const imageData = tempCtx.getImageData(0, 0, width, height);
        const data = imageData.data;
        
        // Apply contrast enhancement for better text recognition
        for (let i = 0; i < data.length; i += 4) {
            // Convert to grayscale and enhance contrast
            const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
            const enhanced = gray < 128 ? gray * 0.5 : Math.min(255, gray * 1.5);
            data[i] = enhanced;     // R
            data[i + 1] = enhanced; // G
            data[i + 2] = enhanced; // B
            // Alpha channel stays the same
        }
        
        tempCtx.putImageData(imageData, 0, 0);

        return tempCanvas;
    };

    // Optimized function to run OCR on detected regions using Tesseract.js
    const runOCROnDetections = function(predictions) {
        if (!predictions || predictions.length === 0) {
            return;
        }

        // Wait for OCR worker to be ready
        if (!ocrWorker || !ocrInitialized) {
            // Retry initialization if it failed
            if (!ocrInitialized) {
                initializeOCR();
            }
            return;
        }

        const currentTime = Date.now();
        if (currentTime - lastOCRTime < ocrThrottle) {
            return; // Throttle OCR calls to optimize performance
        }
        lastOCRTime = currentTime;

        // Clear previous results
        $("#text-results").empty();

        // Process each detection
        predictions.forEach(function(prediction, index) {
            // Only process if detection is large enough (optimize performance)
            if (prediction.bbox.width < 50 || prediction.bbox.height < 50) {
                return;
            }
            
            const regionCanvas = extractImageRegion(prediction);
            
            // Create a detection item element
            const detectionItem = $('<div>').addClass('detection-item');
            const label = $('<div>').addClass('detection-label').text(prediction.class);
            const textDiv = $('<div>').addClass('detection-text').text('Processing OCR...');
            detectionItem.append(label).append(textDiv);
            $("#text-results").append(detectionItem);

            // Run OCR using Tesseract.js with optimized settings
            ocrWorker.recognize(regionCanvas, {
                tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,;:!?-()[]{}"/\\@#$%^&*+=<>|~`',
                tessedit_pageseg_mode: '6', // Assume a single uniform block of text
            })
            .then(function(result) {
                const extractedText = result.data.text.trim();
                if (extractedText && extractedText.length > 0) {
                    textDiv.text(extractedText);
                    // Show confidence score
                    if (result.data.confidence) {
                        const confidence = Math.round(result.data.confidence);
                        textDiv.attr('title', 'Confidence: ' + confidence + '%');
                    }
                } else {
                    textDiv.text('No text detected');
                }
            })
            .catch(function(err) {
                console.error('OCR error:', err);
                textDiv.text('OCR Error: ' + (err.message || 'Processing failed'));
                textDiv.attr('title', 'OCR processing error');
            });
        });
    };

    const detectFrame = function () {
        if (!workerId) return requestAnimationFrame(detectFrame);

        const image = new CVImage(video);
        inferEngine
            .infer(workerId, image)
            .then(function (predictions) {
                requestAnimationFrame(detectFrame);
                renderPredictions(predictions);

                // Run OCR on detected regions (throttled)
                if (predictions && predictions.length > 0) {
                    runOCROnDetections(predictions);
                }

                if (prevTime) {
                    pastFrameTimes.push(Date.now() - prevTime);
                    if (pastFrameTimes.length > 30) pastFrameTimes.shift();

                    var total = 0;
                    _.each(pastFrameTimes, function (t) {
                        total += t / 1000;
                    });

                    var fps = pastFrameTimes.length / total;
                    $("#fps").text(Math.round(fps));
                }
                prevTime = Date.now();
            })
            .catch(function (e) {
                console.log("CAUGHT", e);
                requestAnimationFrame(detectFrame);
            });
    };
});
