console.log('script.js loaded');

// Add near the top of the file with other global variables
const COMFYUI_API_URL = 'http://127.0.0.1:8188';  // Match backend URL
const SOCKET_URL = 'http://127.0.0.1:3000';  // Updated WebSocket server URL

// Replace imports with direct references to the global firebase objects
// import { firebaseConfig } from './firebase-config.js';
// import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
// import { getStorage, ref, uploadBytes, getDownloadURL, listAll } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";
// import { getDatabase, ref as dbRef, onValue } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

// Initialize Firebase if firebaseConfig exists
let app, storage, database;
if (typeof firebaseConfig !== 'undefined') {
    app = firebase.initializeApp(firebaseConfig);
    storage = firebase.storage();
    database = firebase.database();

    // Make Firebase services available globally
    window.firebaseApp = app;
    window.firebaseStorage = storage;
    window.firebaseDatabase = database;
}

// Global variables declaration
let map = null;
window.map = null; // Make map globally available
let submissionsMap = null;
let autocomplete = null;
let geocoder = null;
let currentMarker = null;
let currentInfoWindow = null;
let streetViewService = null;
let imageSourceSelect = null;
let streetViewSection = null;
let submissionMarkers = [];
let currentSubmissionLocation = null;

// Global variables
let isDrawing = false;
let brushSize = 5;  // Start with default size of 5 (to match slider default)
let isEraser = false; // To track eraser mode
let maskCanvas = null;
let maskCtx = null;
let imageCanvas = null;
let imageCtx = null;
let currentImage = null;
let originalImage = null; // Store original image dimensions
let currentTool = 'brush';
let marker;
let cursorCanvas = null;
let cursorCtx = null;
let lastX = null;
let lastY = null;
let mouseX = null; // Track mouse X position globally
let mouseY = null; // Track mouse Y position globally
let socket;
let userId = null; // Initialize userId globally
let userColor;
const connectedUsers = new Map();

// Near the top with other global variables
let imageUpload, submissionsLayer;

// Add these global variables at the top
let generatedImageUrl;
let submissionsModal;
let submissionsMarkers = [];
let submissionClusters = {}; // Object to store submission clusters by location
let submissionVotes = {}; // Object to store votes for submissions

// Add these global variables at the top
let mainMapMarker = null;
let submissionsMapMarker = null;

// Store the current slider contributions to prompts
const sliderContributions = {
    'lighting': { main: '', context: '' },
    'layout': { main: '', context: '' },
    'community': { main: '', context: '' },
    'functionality': { main: '', context: '' },
    'visual-elements': { main: '', context: '' }
};

// Add near the top with other global variables
let brushCursorImage = null;
let eraserCursorImage = null;

// Add this global variable near the top with the other globals
let imageLoadedFromModal = false; // Flag to track if image was loaded from modal

// Add at the top of the file with other global variables
const userColors = {
    self: '#4CAF50',  // Green for current user
    others: ['#FF6B6B', '#45B7D1', '#FFD93D', '#9C27B0']  // Colors for other users
};
let currentUserColor = userColors.self;
let connectedUserColors = new Map(); // Map to track other users' colors

// Add this near the top with other global variables
const userDrawingBubbles = new Map();

// Add this CSS for the drawing bubble
const style = document.createElement('style');
style.textContent = `
    .drawing-bubble {
        position: absolute;
        background: white;
        color: black;
        padding: 6px 12px;
        border-radius: 50px;
        font-size: 12px;
        pointer-events: none;
        z-index: 1000;
        white-space: nowrap;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        border: 2px solid currentColor;
    }
`;
document.head.appendChild(style);

// Function to save votes to both localStorage and backend
async function saveVotes() {
    try {
        // Save to localStorage
        localStorage.setItem('submissionVotes', JSON.stringify(submissionVotes));
        console.log('Saved votes to localStorage:', Object.keys(submissionVotes).length);
        
        // Save to backend
        const response = await fetch('/api/save-votes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ votes: submissionVotes })
        });
        
        if (!response.ok) {
            throw new Error('Failed to save votes to backend');
        }
        
        console.log('Saved votes to backend successfully');
    } catch (error) {
        console.error('Error saving votes:', error);
    }
}

// Function to load votes from both localStorage and backend
async function initializeVotes() {
    try {
        // Initialize submissionVotes if not already initialized
        if (!submissionVotes) {
            submissionVotes = {};
        }
        
        // Try to load from localStorage first
        const savedVotes = localStorage.getItem('submissionVotes');
        if (savedVotes) {
            const parsedVotes = JSON.parse(savedVotes);
            // Ensure the parsed votes have the correct structure
            Object.keys(parsedVotes).forEach(key => {
                if (!parsedVotes[key].userVotes) {
                    parsedVotes[key].userVotes = {};
                }
            });
            submissionVotes = parsedVotes;
            console.log('Loaded votes from localStorage:', Object.keys(submissionVotes).length);
        }
        
        // Then load from backend
        const response = await fetch('/api/vote-data');
        if (response.ok) {
            const data = await response.json();
            if (data.votes) {
                // Merge backend votes with local votes, ensuring proper structure
                Object.keys(data.votes).forEach(key => {
                    if (!data.votes[key].userVotes) {
                        data.votes[key].userVotes = {};
                    }
                    if (!submissionVotes[key]) {
                        submissionVotes[key] = { upvotes: 0, downvotes: 0, userVotes: {} };
                    }
                    submissionVotes[key] = {
                        ...submissionVotes[key],
                        ...data.votes[key],
                        userVotes: {
                            ...submissionVotes[key].userVotes,
                            ...data.votes[key].userVotes
                        }
                    };
                });
                console.log('Loaded votes from backend:', Object.keys(data.votes).length);
            }
        }
    } catch (error) {
        console.error('Error initializing votes:', error);
        // Ensure submissionVotes is at least an empty object
        submissionVotes = {};
    }
}

// Function to handle voting on a submission
async function voteForSubmission(submissionId, voteType) {
    try {
        // Ensure submissionVotes is initialized
        if (!submissionVotes) {
            submissionVotes = {};
        }
        
        // Create a unique key for this submission
        const voteKey = submissionId || Date.now().toString();
        
        // Initialize if not exists
        if (!submissionVotes[voteKey]) {
            submissionVotes[voteKey] = { upvotes: 0, downvotes: 0, userVotes: {} };
        }
        
        // Ensure the vote object has the correct structure
        if (!submissionVotes[voteKey].userVotes) {
            submissionVotes[voteKey].userVotes = {};
        }
        
        // Ensure userId is set, use socket.id if available, otherwise use a default
        const currentUserId = userId || socket?.id || 'anonymous';
        
        // Get the current user's vote for this submission
        const currentUserVote = submissionVotes[voteKey].userVotes[currentUserId] || null;
        
        // Handle the vote
        if (voteType === 'up') {
            if (currentUserVote === 'upvote') {
                // User is removing their upvote
                submissionVotes[voteKey].upvotes--;
                submissionVotes[voteKey].userVotes[currentUserId] = null;
            } else {
                // If user had a downvote, remove it first
                if (currentUserVote === 'downvote') {
                    submissionVotes[voteKey].downvotes--;
                }
                // Add the upvote
                submissionVotes[voteKey].upvotes++;
                submissionVotes[voteKey].userVotes[currentUserId] = 'upvote';
            }
        } else if (voteType === 'down') {
            if (currentUserVote === 'downvote') {
                // User is removing their downvote
                submissionVotes[voteKey].downvotes--;
                submissionVotes[voteKey].userVotes[currentUserId] = null;
            } else {
                // If user had an upvote, remove it first
                if (currentUserVote === 'upvote') {
                    submissionVotes[voteKey].upvotes--;
                }
                // Add the downvote
                submissionVotes[voteKey].downvotes++;
                submissionVotes[voteKey].userVotes[currentUserId] = 'downvote';
            }
        }
        
        // Save the updated votes
        await saveVotes();
        
        // Dispatch event to update UI
        const event = new CustomEvent('voteUpdated', { detail: { submissionId: voteKey } });
        document.dispatchEvent(event);
        
        return {
            upvotes: submissionVotes[voteKey].upvotes,
            downvotes: submissionVotes[voteKey].downvotes,
            userVote: submissionVotes[voteKey].userVotes[currentUserId]
        };
    } catch (error) {
        console.error('Error in voteForSubmission:', error);
        // Return default values in case of error
        return {
            upvotes: 0,
            downvotes: 0,
            userVote: null
        };
    }
}

// Function to get vote count for a submission
function getVotesForSubmission(submissionId) {
    try {
        if (!submissionId) {
            console.warn('getVotesForSubmission called with undefined submissionId');
            return { upvotes: 0, downvotes: 0, userVote: null };
        }

        const voteKey = submissionId.toString();  // Ensure it's a string
        const votes = submissionVotes[voteKey] || { upvotes: 0, downvotes: 0, userVotes: {} };
        
        // Use the same user ID logic as voteForSubmission
        const currentUserId = userId || socket?.id || 'anonymous';
        
        return {
            upvotes: votes.upvotes || 0,
            downvotes: votes.downvotes || 0,
            userVote: votes.userVotes?.[currentUserId] || null
        };
    } catch (error) {
        console.error('Error in getVotesForSubmission:', error);
        return { upvotes: 0, downvotes: 0, userVote: null };
    }
}

// Function to load submissions from localStorage and server
function loadSubmissions() {
    try {
        console.log('Loading submissions, adding debug logs to troubleshoot empty map');
        
        // Initialize votes system
        initializeVotes();
        
        // Clear existing markers
        submissionsMarkers.forEach(marker => marker.setMap(null));
        submissionsMarkers = [];
        
        // Reset clusters
        submissionClusters = {};
        
        // Try to load from localStorage first
        const localSubmissions = JSON.parse(localStorage.getItem('submissions') || '[]');
        console.log('Loaded local submissions:', localSubmissions.length);
        
        // Always create some dummy data for testing
        const dummySubmissions = createDummySubmissions();
        console.log('Created dummy submissions:', dummySubmissions.length);
        
        // Group submissions by location (for clustering)
        localSubmissions.forEach(submission => {
            groupSubmissionByLocation(submission);
        });
        
        // Always add dummy submissions (for testing and to ensure something is visible)
        dummySubmissions.forEach(submission => {
            groupSubmissionByLocation(submission);
        });
        
        console.log('Grouped submissions into clusters:', Object.keys(submissionClusters).length);
        
        // Create cluster markers immediately for local and dummy data
        createClusterMarkers();
        
        // Initialize or update heatmap if visualization library is loaded
        if (submissionsMap && typeof google !== 'undefined' && google.maps && google.maps.visualization) {
            if (window.submissionsHeatmap) {
                updateHeatmapData();
            } else {
                initializeHeatmap(submissionsMap);
            }
        }
        
        // If connected to server, request server submissions
        if (socket && socket.connected) {
            console.log('Requesting submissions from server');
            socket.emit('get_submissions');
            
            // Listen for submissions from server (one-time listener)
            socket.once('submissions_list', (data) => {
                console.log('Received submissions from server:', data.submissions.length);
                
                // Clear existing markers for refresh
                submissionsMarkers.forEach(marker => marker.setMap(null));
                submissionsMarkers = [];
                
                // Group server submissions by location
                data.submissions.forEach(submission => {
                    // Check if we already have this submission locally (avoid duplicates)
                    const isDuplicate = localSubmissions.some(
                        local => local.imageUrl === submission.imageUrl && 
                               local.submittedAt === submission.submittedAt
                    );
                    
                    if (!isDuplicate) {
                        groupSubmissionByLocation(submission);
                    }
                });
                
                // Create cluster markers after all submissions are processed
                createClusterMarkers();
                
                // Update heatmap with new data
                if (window.submissionsHeatmap) {
                    updateHeatmapData();
                }
            });
        }
    } catch (error) {
        console.error('Error loading submissions:', error);
        
        // Fallback - always create dummy submissions if there was an error
        try {
            console.log('Creating fallback dummy submissions after error');
            const dummySubmissions = createDummySubmissions();
            
            // Clear existing data
            submissionClusters = {};
            submissionsMarkers.forEach(marker => marker.setMap(null));
            submissionsMarkers = [];
            
            // Add dummy data
            dummySubmissions.forEach(submission => {
                groupSubmissionByLocation(submission);
            });
            
            // Create markers
            createClusterMarkers();
            
            // Create heatmap even in fallback mode
            if (submissionsMap && typeof google !== 'undefined' && google.maps && google.maps.visualization) {
                if (window.submissionsHeatmap) {
                    updateHeatmapData();
                } else {
                    initializeHeatmap(submissionsMap);
                }
            }
        } catch (fallbackError) {
            console.error('Even fallback dummy submissions failed:', fallbackError);
        }
    }
}

// Function to group a submission by its location (for clustering)
function groupSubmissionByLocation(submission) {
    if (!submission.location) return;
    
    // Create a location key with reduced precision (for clustering nearby locations)
    // Using 4 decimal places (~11 meters of precision)
    const locationKey = `${submission.location.lat.toFixed(4)},${submission.location.lng.toFixed(4)}`;
    
    // Initialize cluster if it doesn't exist
    if (!submissionClusters[locationKey]) {
        submissionClusters[locationKey] = {
            location: submission.location,
            submissions: []
        };
    }
    
    // Add this submission to its cluster
    submissionClusters[locationKey].submissions.push(submission);
}

// Function to create markers for clusters
function createClusterMarkers() {
    if (!submissionsMap) {
        console.error('Submissions map not initialized when creating clusters');
        return;
    }
    
    console.log('Creating cluster markers for', Object.keys(submissionClusters).length, 'clusters');
    
    // Array of vibrant colors for markers
    const markerColors = ['#FF5733', '#33FF57', '#3357FF', '#FF33F5', '#F5FF33', '#33FFF5', '#FF3333'];
    
    // Process each cluster
    Object.values(submissionClusters).forEach((cluster, index) => {
        const position = new google.maps.LatLng(
            cluster.location.lat,
            cluster.location.lng
        );
        
        // Determine cluster size for visual representation
        const submissionCount = cluster.submissions.length;
        const size = Math.min(150, Math.max(80, 60 + (submissionCount * 10))); // Even bigger size between 80-150px
        
        // Get color based on index (cycle through colors)
        const color = markerColors[index % markerColors.length];
        
        console.log('Creating cluster for', submissionCount, 'submissions at', position.toString(), 'with size', size);
        
        // Create a custom animated marker for the cluster
        const marker = new google.maps.Marker({
            position: position,
            map: submissionsMap,
            title: `${submissionCount} submission${submissionCount !== 1 ? 's' : ''}`,
            icon: {
                path: google.maps.SymbolPath.CIRCLE,
                fillColor: color,
                fillOpacity: 0.7,
                strokeColor: '#ffffff',
                strokeWeight: 3,
                scale: size / 10, // Scale the circle based on submission count
            },
            label: {
                text: submissionCount.toString(),
                color: 'white',
                fontSize: '18px',
                fontWeight: 'bold'
            },
            animation: google.maps.Animation.BOUNCE, // Add bounce animation
            optimized: false // Required for some animations to work properly
        });
        
        // Stop the bouncing after a shorter time
        setTimeout(() => {
            marker.setAnimation(null);
        }, 1500);
        
        // Add pulsating effect via scale changes with faster animation
        let direction = 1;
        let currentScale = size / 10;
        const scaleFactor = 0.1; // Doubled for faster animation
        const minScale = (size / 10) * 0.9;
        const maxScale = (size / 10) * 1.1;
        
        // Create pulsating effect with faster interval
        const pulse = setInterval(() => {
            try {
                if (!marker.getMap()) {
                    clearInterval(pulse);
                    return;
                }
                
                // Update scale based on direction
                currentScale += scaleFactor * direction;
                
                // Check if we need to change direction
                if (currentScale >= maxScale) direction = -1;
                if (currentScale <= minScale) direction = 1;
                
                // Apply new scale
                const icon = marker.getIcon();
                icon.scale = currentScale;
                marker.setIcon(icon);
    } catch (error) {
                console.error('Error in pulse animation:', error);
                clearInterval(pulse);
            }
        }, 50); // Faster interval for more fluid animation
        
        // Add click event to show submissions in the cluster
        marker.addListener('click', () => {
            console.log('Cluster clicked:', cluster);
            showClusterSubmissions(cluster, marker);
        });
        
        submissionsMarkers.push(marker);
        console.log('Added cluster marker to submissionsMarkers array, new length:', submissionsMarkers.length);
    });
}

// Function to show submissions in a cluster
function showClusterSubmissions(cluster, marker) {
    try {
        // Close previous info window if open
        if (currentInfoWindow) {
            currentInfoWindow.close();
        }
        
        // Filter out dummy and unavailable images first
        const filteredSubmissions = cluster.submissions.filter(submission => {
            // Filter out dummy submissions
            if (submission.imageUrl && submission.imageUrl.includes('dummy')) {
                return false;
            }
            // Filter out placeholder images or unavailable images
            if (submission.imageUrl && submission.imageUrl.includes('placehold.co')) {
                return false;
            }
            if (submission.imageUrl && submission.imageUrl.includes('Image+Not+Available')) {
                return false;
            }
            // Include all other submissions with valid images
            return submission.imageUrl;
        });
        
        // Create content for the info window with all submissions in the cluster as a 2x2 grid
        let content = `<div class="cluster-submissions" style="color: var(--text-primary); padding: 0; max-width: 650px; max-height: 500px; overflow-y: auto;">
                           <h3 style="margin-top: 0; margin-bottom: 15px; color: var(--accent-primary); text-align: center; position: sticky; top: 0; background: var(--bg-primary); padding: 15px 5px 10px 5px; z-index: 2; border-bottom: 1px solid var(--glass-border);">
                             ${filteredSubmissions.length} Submission${filteredSubmissions.length !== 1 ? 's' : ''} At This Location
                           </h3>
                           <div style="padding: 0 15px 15px 15px;">`;
        
        // Handle case with no valid submissions
        if (filteredSubmissions.length === 0) {
            content += `<div style="padding: 20px; text-align: center; background: var(--bg-secondary); border-radius: var(--bento-radius);">
                          <p style="margin: 0; color: var(--text-secondary);">No valid submissions available to display</p>
                        </div></div></div>`;
                        
            // Create and open new info window
            currentInfoWindow = new google.maps.InfoWindow({
                content: content,
                maxWidth: 650,
                pixelOffset: new google.maps.Size(0, -10)
            });
            
            currentInfoWindow.open(submissionsMap, marker);
            return;
        }
        
        // Add 2x2 grid layout for submissions
        content += `<div class="submissions-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">`;
        
        // Sort submissions by votes before displaying
        const sortedSubmissions = [...filteredSubmissions].sort((a, b) => {
            const votesA = getVotesForSubmission(a.submittedAt || a.timestamp);
            const votesB = getVotesForSubmission(b.submittedAt || b.timestamp);
            return (votesB.upvotes - votesB.downvotes) - (votesA.upvotes - votesA.downvotes);
        });
        
        // Add each submission as a grid item (limit to 4 for 2x2 grid)
        const maxDisplayCount = Math.min(sortedSubmissions.length, 4);
        
        for (let i = 0; i < maxDisplayCount; i++) {
            const submission = sortedSubmissions[i];
            const submissionId = submission.submittedAt || Date.now().toString();
            const votes = getVotesForSubmission(submissionId);
            
            content += `<div class="submission-item" data-id="${submissionId}" style="background: var(--bg-secondary); border-radius: var(--bento-radius); padding: 10px; border: 1px solid var(--glass-border); box-shadow: var(--shadow-sm);">`;
            
            if (submission.imageUrl) {
                content += `<div style="text-align: center;">
                                <img src="${submission.imageUrl}" 
                                    style="width: 100%; height: 120px; border-radius: 8px; margin-bottom: 10px; display: block; margin: 0 auto; object-fit: cover; border: 1px solid var(--glass-border);"
                                    onerror="this.style.display='none'; this.parentNode.innerHTML += '<p style=\'color: var(--text-secondary); font-size: 12px;\'>Image not available</p>';" />
                            </div>`;
            }
            
            content += `
                <p style="margin: 10px 0 5px; font-size: var(--font-size-sm);"><strong style="color: var(--accent-primary);">Main: </strong>${submission.prompts?.mainSubject || 'Unknown'}</p>
                <p style="margin: 5px 0 15px; font-size: var(--font-size-sm);"><strong style="color: var(--accent-primary);">Context: </strong>${submission.prompts?.context || 'Generated image'}</p>
                
                <div class="voting-container" style="display: flex; justify-content: flex-end; align-items: center; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--glass-border);">
                    <div class="votes-display" style="color: var(--text-secondary); font-size: var(--font-size-xs);">
                        ${votes.upvotes - votes.downvotes} votes
                    </div>
                </div>
            </div>`;
        }
        
        // Add action buttons including View All and AI Insights
        if (filteredSubmissions.length > 0) {
            content += `<div style="grid-column: span 2; text-align: center; padding: 15px; background: var(--bg-secondary); border-radius: var(--bento-radius); margin-top: 10px; border: 1px solid var(--glass-border); position: sticky; bottom: 0; z-index: 2; margin-bottom: 5px; display: flex; gap: 10px; justify-content: center;">`;
            
            // Add View All button if there are more than 4 submissions
        if (filteredSubmissions.length > 4) {
                content += `<button id="view-all-submissions" style="background: var(--accent-primary); color: white; border: none; border-radius: 6px; padding: 8px 15px; cursor: pointer; font-weight: 500; transition: all 0.2s ease; flex: 1;">View All ${filteredSubmissions.length} Submissions</button>`;
            }
            
            // Add AI Insights button
            content += `<button id="ai-insights-btn" style="background: var(--accent-secondary); color: white; border: none; border-radius: 6px; padding: 8px 15px; cursor: pointer; font-weight: 500; transition: all 0.2s ease; flex: 1;">🤖 AI Insights</button>`;
            
            content += `</div>`;
        }
        
        content += `</div></div></div>`;
        
        // Create and open new info window with increased max width
        currentInfoWindow = new google.maps.InfoWindow({
            content: content,
            maxWidth: 650, // Width for 2x2 grid
            pixelOffset: new google.maps.Size(0, -10)
        });
        
        // Add event listeners for voting after the info window is displayed
        google.maps.event.addListenerOnce(currentInfoWindow, 'domready', () => {
            try {
                // Style the info window
                styleInfoWindow();
                
                // Set up View All button hover effect and click handler
                const viewAllBtn = document.getElementById('view-all-submissions');
                if (viewAllBtn) {
                    viewAllBtn.addEventListener('mouseover', function() {
                        this.style.backgroundColor = 'var(--accent-secondary)';
                        this.style.transform = 'translateY(-2px)';
                        this.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.2)';
                    });
                    viewAllBtn.addEventListener('mouseout', function() {
                        this.style.backgroundColor = 'var(--accent-primary)';
                        this.style.transform = 'translateY(0)';
                        this.style.boxShadow = 'none';
                    });
                    viewAllBtn.addEventListener('click', function() {
                        showAllSubmissionsModal(cluster);
                    });
                }
                
                // Set up AI Insights button hover effect and click handler
                const aiInsightsBtn = document.getElementById('ai-insights-btn');
                if (aiInsightsBtn) {
                    aiInsightsBtn.addEventListener('mouseover', function() {
                        this.style.backgroundColor = '#1976D2'; // Darker blue
                        this.style.transform = 'translateY(-2px)';
                        this.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.2)';
                    });
                    aiInsightsBtn.addEventListener('mouseout', function() {
                        this.style.backgroundColor = 'var(--accent-secondary)';
                        this.style.transform = 'translateY(0)';
                        this.style.boxShadow = 'none';
                    });
                    aiInsightsBtn.addEventListener('click', function() {
                        // Close the info window first
                        if (currentInfoWindow) {
                            currentInfoWindow.close();
                        }
                        // Show AI insights for this specific cluster
                        showAIInsightsModal(cluster);
                    });
                }
                
                // Ensure the buttons are visible by scrolling to them if needed
                if (viewAllBtn || aiInsightsBtn) {
                    setTimeout(() => {
                        const buttonToScroll = viewAllBtn || aiInsightsBtn;
                        buttonToScroll.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }, 200);
                }
                
            } catch (error) {
                console.error('Error setting up info window interactions:', error);
            }
        });
        
        // Add click listener to map to close info window when clicking outside
        google.maps.event.addListenerOnce(submissionsMap, 'click', function(event) {
            if (currentInfoWindow) {
                currentInfoWindow.close();
            }
        });
        
        currentInfoWindow.open(submissionsMap, marker);
        
    } catch (error) {
        console.error('Error showing cluster submissions:', error);
    }
}

// Add this function before showAllSubmissionsModal
function createSubmissionItem(submission) {
    const submissionItem = document.createElement('div');
    submissionItem.className = 'submission-item';
    submissionItem.style.position = 'relative';
    submissionItem.style.aspectRatio = '1 / 1';
    submissionItem.style.overflow = 'hidden';
    submissionItem.style.borderRadius = '8px';
    submissionItem.style.cursor = 'pointer';
    submissionItem.style.backgroundColor = 'var(--bg-secondary)';
    submissionItem.style.border = '1px solid var(--glass-border)';
    submissionItem.style.transition = 'transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease';
    submissionItem.style.width = '100%';
    submissionItem.style.minHeight = '200px';
    submissionItem.style.boxSizing = 'border-box';

    // Skip creating the item if imageUrl is missing or contains placeholder/dummy references
    if (!submission.imageUrl || 
        submission.imageUrl.includes('dummy') || 
        submission.imageUrl.includes('placehold.co') || 
        submission.imageUrl.includes('Image+Not+Available')) {
        return null;
    }

    // Image container
    const imageContainer = document.createElement('div');
    imageContainer.style.width = '100%';
    imageContainer.style.height = '100%';
    imageContainer.style.position = 'relative';
    imageContainer.style.overflow = 'hidden';

    // Create image element
    const image = document.createElement('img');
    image.src = submission.imageUrl;
    image.style.width = '100%';
    image.style.height = '100%';
    image.style.objectFit = 'cover';
    image.style.position = 'relative';
    image.style.zIndex = '0';

    // Create hover overlay
    const overlay = document.createElement('div');
    overlay.style.position = 'absolute';
    overlay.style.bottom = '0';
    overlay.style.left = '0';
    overlay.style.right = '0';
    overlay.style.height = '50%';
    overlay.style.background = 'linear-gradient(transparent, rgba(0, 0, 0, 0.6))';
    overlay.style.color = 'white';
    overlay.style.padding = '20px';
    overlay.style.boxSizing = 'border-box';
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity 0.3s ease';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.justifyContent = 'flex-end';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '1';

    // Get votes for this submission
    const submissionId = submission.timestamp || submission.submittedAt;
    const votes = getVotesForSubmission(submissionId);

    // Vote count element
    const voteCount = document.createElement('div');
    voteCount.className = 'vote-count';
    voteCount.style.position = 'absolute';
    voteCount.style.top = '10px';
    voteCount.style.right = '10px';
    voteCount.style.background = 'rgba(0, 0, 0, 0.6)';
    voteCount.style.padding = '4px 8px';
    voteCount.style.borderRadius = '12px';
    voteCount.style.fontSize = '12px';
    voteCount.style.color = 'white';
    voteCount.textContent = `${votes.upvotes - votes.downvotes} votes`;

    // Metadata content
    const content = document.createElement('div');
    content.style.marginTop = 'auto';
    content.innerHTML = `
        <div style="font-size: 14px; font-weight: bold; margin-bottom: 4px;">
            ${submission.prompts?.mainSubject || 'Unknown'}
        </div>
        <div style="font-size: 12px; opacity: 0.9;">
            ${submission.prompts?.context || 'Generated Image'}
        </div>
    `;

    // Add hover handlers
    submissionItem.addEventListener('mouseenter', () => {
        overlay.style.opacity = '1';
        submissionItem.style.transform = 'scale(1.02)';
        submissionItem.style.boxShadow = 'var(--shadow-lg)';
        submissionItem.style.borderColor = 'var(--accent-primary)';
    });

    submissionItem.addEventListener('mouseleave', () => {
        overlay.style.opacity = '0';
        submissionItem.style.transform = 'scale(1)';
        submissionItem.style.boxShadow = 'none';
        submissionItem.style.borderColor = 'var(--glass-border)';
    });

    // Click handler
    submissionItem.addEventListener('click', () => {
        const votes = getVotesForSubmission(submission.timestamp || submission.submittedAt);
        showFullImageModal(submission.imageUrl, submission, votes);
    });

    // Add fallback for image load error - remove the item from DOM if image fails to load
    image.onerror = function() {
        // Try to remove this item from the parent container
        if (submissionItem.parentNode) {
            submissionItem.parentNode.removeChild(submissionItem);
        }
        return false; // Stop further error handling
    };

    // Assemble the submission item
    overlay.appendChild(voteCount);
    overlay.appendChild(content);
    imageContainer.appendChild(image);
    imageContainer.appendChild(overlay);
    submissionItem.appendChild(imageContainer);

    return submissionItem;
}

// Update showAllSubmissionsModal to use the new createSubmissionItem function
function showAllSubmissionsModal(cluster) {
    // Remove any existing modals first
    const existingModals = document.querySelectorAll('.submissions-modal-overlay');
    existingModals.forEach(modal => modal.remove());

    const modalOverlay = document.createElement('div');
    modalOverlay.className = 'submissions-modal-overlay';
    modalOverlay.style.position = 'fixed';
    modalOverlay.style.top = '0';
    modalOverlay.style.left = '0';
    modalOverlay.style.width = '100%';
    modalOverlay.style.height = '100%';
    modalOverlay.style.background = 'rgba(0, 0, 0, 0.5)';
    modalOverlay.style.backdropFilter = 'blur(5px)';
    modalOverlay.style.display = 'flex';
    modalOverlay.style.justifyContent = 'center';
    modalOverlay.style.alignItems = 'flex-start'; // Change from center to flex-start
    modalOverlay.style.paddingTop = '30px'; // Add padding-top to position the modal
    modalOverlay.style.zIndex = '2000000';
    modalOverlay.style.overflow = 'auto'; // Allow scrolling on the overlay itself

    const modal = document.createElement('div');
    modal.className = 'submissions-modal';
    modal.style.width = '90vw';
    modal.style.maxHeight = '90vh';
    modal.style.background = 'var(--bg-primary)';
    modal.style.borderRadius = '12px';
    modal.style.padding = '0'; // Remove top padding
    modal.style.paddingBottom = '20px'; // Add padding just to the bottom
    modal.style.position = 'relative';
    modal.style.display = 'flex';
    modal.style.flexDirection = 'column';
    modal.style.zIndex = '2000001';
    modal.style.overflow = 'hidden'; // Hidden on the main container to contain inner scrollable areas
    modal.style.marginTop = '0'; // Ensure no top margin

    // Modal header with buttons
    const modalHeader = document.createElement('div');
    modalHeader.style.display = 'flex';
    modalHeader.style.justifyContent = 'space-between';
    modalHeader.style.alignItems = 'center';
    modalHeader.style.marginBottom = '20px';
    modalHeader.style.padding = '30px 30px 10px';
    modalHeader.style.flexShrink = '0'; // Prevent header from shrinking
    modalHeader.style.width = '100%';
    modalHeader.style.boxSizing = 'border-box';

    // Left section with title
    const titleSection = document.createElement('div');
    if (cluster && cluster.location) {
        const lat = cluster.location.lat.toFixed(4);
        const lng = cluster.location.lng.toFixed(4);
        titleSection.innerHTML = `<h2 style="margin: 0;">All Submissions at (${lat}, ${lng})</h2>`;
    } else {
    titleSection.innerHTML = '<h2 style="margin: 0;">All Submissions</h2>';
    }

    // Right section with buttons
    const buttonSection = document.createElement('div');
    buttonSection.style.display = 'flex';
    buttonSection.style.gap = '10px';

    // AI Insights button
    const aiButton = document.createElement('button');
    aiButton.innerHTML = '🤖 AI Insights';
    aiButton.style.padding = '8px 16px';
    aiButton.style.background = 'var(--accent-primary)';
    aiButton.style.color = 'white';
    aiButton.style.border = 'none';
    aiButton.style.borderRadius = '6px';
    aiButton.style.cursor = 'pointer';
    aiButton.style.transition = 'all 0.2s ease';
    aiButton.onmouseover = function() {
        this.style.backgroundColor = '#1976D2'; // Darker blue
        this.style.transform = 'translateY(-2px)';
        this.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.2)';
    };
    aiButton.onmouseout = function() {
        this.style.backgroundColor = 'var(--accent-primary)';
        this.style.transform = 'translateY(0)';
        this.style.boxShadow = 'none';
    };
    aiButton.onclick = function() {
        // Pass the cluster to analyze only this cluster's submissions
        showAIInsightsModal(cluster);
    };

    // Download Report button
    const downloadButton = document.createElement('button');
    downloadButton.innerHTML = '📥 Download Report';
    downloadButton.style.padding = '8px 16px';
    downloadButton.style.background = 'var(--accent-secondary)';
    downloadButton.style.color = 'white';
    downloadButton.style.border = 'none';
    downloadButton.style.borderRadius = '6px';
    downloadButton.style.cursor = 'pointer';
    downloadButton.style.transition = 'all 0.2s ease';
    downloadButton.onmouseover = function() {
        this.style.backgroundColor = '#45a049'; // Darker green
        this.style.transform = 'translateY(-2px)';
        this.style.boxShadow = '0 4px 8px rgba(0, 0, 0, 0.2)';
    };
    downloadButton.onmouseout = function() {
        this.style.backgroundColor = 'var(--accent-secondary)';
        this.style.transform = 'translateY(0)';
        this.style.boxShadow = 'none';
    };
    downloadButton.onclick = function() {
        // If we have a cluster, generate report for just this cluster
        if (cluster) {
            // Create a form for POST submission
            const form = document.createElement('form');
            form.method = 'POST';
            form.action = '/api/generate-cluster-report';
            form.target = '_blank';
            form.style.display = 'none';
            
            // Add cluster data as input
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = 'cluster_data';
            input.value = JSON.stringify({
                submissions: cluster.submissions,
                location: cluster.location
            });
            form.appendChild(input);
            
            // Submit the form
            document.body.appendChild(form);
            form.submit();
            document.body.removeChild(form);
        } else {
            // Generate report for all submissions
            generateSubmissionsReport();
        }
    };

    // Close button
    const closeButton = document.createElement('button');
    closeButton.innerHTML = '&times;';
    closeButton.style.position = 'absolute';
    closeButton.style.top = '15px';
    closeButton.style.right = '15px';
    closeButton.style.backgroundColor = 'transparent';
    closeButton.style.border = 'none';
    closeButton.style.color = 'var(--text-primary)';
    closeButton.style.fontSize = '28px';
    closeButton.style.cursor = 'pointer';
    closeButton.onclick = () => {
        document.body.removeChild(modalOverlay);
    };

    // Assemble the header
    buttonSection.appendChild(aiButton);
    buttonSection.appendChild(downloadButton);
    modalHeader.appendChild(titleSection);
    modalHeader.appendChild(buttonSection);
    modal.appendChild(modalHeader);
    modal.appendChild(closeButton);

    // Create submissions container
    const submissionsContainer = document.createElement('div');
    submissionsContainer.style.flex = '1';
    submissionsContainer.style.overflow = 'auto'; // Enable scrolling
    submissionsContainer.style.overflowY = 'scroll'; // Force vertical scrollbar to be visible
    submissionsContainer.style.padding = '0 20px 20px 20px'; // Remove top padding, keep sides and bottom
    submissionsContainer.style.width = '100%';
    submissionsContainer.style.maxHeight = 'calc(90vh - 100px)'; // Subtract header height
    submissionsContainer.style.boxSizing = 'border-box';
    submissionsContainer.style.position = 'relative';

    // Create a masonry-style grid wrapper
    const gridWrapper = document.createElement('div');
    gridWrapper.style.display = 'grid';
    gridWrapper.style.gridTemplateColumns = 'repeat(6, 1fr)';
    gridWrapper.style.gap = '10px';
    gridWrapper.style.width = '100%';
    gridWrapper.style.gridAutoRows = '1fr';
    gridWrapper.style.paddingBottom = '20px'; // Add padding at the bottom to ensure last row is visible

    // Function to update the grid with current vote counts
    function updateGridWithVotes() {
        // Clear existing content
        gridWrapper.innerHTML = '';

        // Filter out dummy images and unavailable images
        const filteredSubmissions = cluster.submissions.filter(submission => {
            // Filter out dummy submissions
            if (submission.imageUrl && submission.imageUrl.includes('dummy')) {
                return false;
            }
            // Filter out placeholder images or unavailable images
            if (submission.imageUrl && submission.imageUrl.includes('placehold.co')) {
                return false;
            }
            if (submission.imageUrl && submission.imageUrl.includes('Image+Not+Available')) {
                return false;
            }
            // Include all other submissions
            return true;
        });

        // Sort submissions by votes
        const sortedSubmissions = [...filteredSubmissions].sort((a, b) => {
            const votesA = getVotesForSubmission(a.timestamp || a.submittedAt);
            const votesB = getVotesForSubmission(b.timestamp || b.submittedAt);
            return (votesB.upvotes - votesB.downvotes) - (votesA.upvotes - votesA.downvotes);
        });

        // Display a message if no valid submissions are found
        if (sortedSubmissions.length === 0) {
            const noSubmissionsMsg = document.createElement('div');
            noSubmissionsMsg.style.gridColumn = 'span 6';
            noSubmissionsMsg.style.padding = '40px';
            noSubmissionsMsg.style.textAlign = 'center';
            noSubmissionsMsg.style.color = 'var(--text-secondary)';
            noSubmissionsMsg.style.backgroundColor = 'var(--bg-secondary)';
            noSubmissionsMsg.style.borderRadius = '8px';
            noSubmissionsMsg.style.border = '1px solid var(--glass-border)';
            noSubmissionsMsg.innerHTML = '<h3>No Valid Submissions</h3><p>There are no valid submissions available to display.</p>';
            gridWrapper.appendChild(noSubmissionsMsg);
            return;
        }

        sortedSubmissions.forEach((submission, index) => {
            const submissionItem = createSubmissionItem(submission);
            
            if (!submissionItem) return; // Skip if null (invalid submission)
            
            // Get current vote state for this submission
            const submissionId = submission.timestamp || submission.submittedAt;
            const votes = getVotesForSubmission(submissionId);
            
            // Update the vote count display
            const voteCountElement = submissionItem.querySelector('.vote-count');
            if (voteCountElement) {
                voteCountElement.textContent = `${votes.upvotes - votes.downvotes} votes`;
            }
            
            // Base styles for all items
            submissionItem.style.width = '100%';
            submissionItem.style.height = '100%';
            submissionItem.style.position = 'relative';
            submissionItem.style.overflow = 'hidden';
            submissionItem.style.borderRadius = '8px';
            submissionItem.style.backgroundColor = 'var(--bg-secondary)';

            // Style based on vote ranking
            if (index === 0) {
                // Highest votes: 3x3
                submissionItem.style.gridColumn = 'span 3';
                submissionItem.style.gridRow = 'span 3';
            } else if (index === 1) {
                // Second highest: 2x2
                submissionItem.style.gridColumn = 'span 2';
                submissionItem.style.gridRow = 'span 2';
            } else {
                // All others: 1x1
                submissionItem.style.gridColumn = 'span 1';
                submissionItem.style.gridRow = 'span 1';
            }

            gridWrapper.appendChild(submissionItem);
        });
    }

    // Initial grid update
    updateGridWithVotes();

    // Add event listener for vote updates
    document.addEventListener('voteUpdated', updateGridWithVotes);

    // Assemble the modal
    submissionsContainer.appendChild(gridWrapper);
    modal.appendChild(submissionsContainer);
    modalOverlay.appendChild(modal);
    document.body.appendChild(modalOverlay);

    // Add resize observer to adjust grid columns based on container width
    const resizeObserver = new ResizeObserver(entries => {
        for (let entry of entries) {
            const width = entry.contentRect.width;
            const columns = Math.floor(width / 200); // Adjust number of columns based on container width
            gridWrapper.style.gridTemplateColumns = `repeat(${Math.max(3, columns)}, 1fr)`;
        }
    });

    resizeObserver.observe(submissionsContainer);

    // Add event listener for vote updates
    const voteUpdateHandler = () => {
        updateGridWithVotes();
    };
    document.addEventListener('voteUpdated', voteUpdateHandler);

    // Update close button to also remove event listener
    closeButton.onclick = () => {
        document.removeEventListener('voteUpdated', voteUpdateHandler);
        document.body.removeChild(modalOverlay);
    };
}

// First add the full image modal function at the top level
function showFullImageModal(imageUrl, submission, votes) {
    try {
        // Remove any existing full image modals
        const existingModals = document.querySelectorAll('.full-image-modal-overlay');
        existingModals.forEach(modal => modal.remove());

        // Create modal overlay
        const modalOverlay = document.createElement('div');
        modalOverlay.className = 'full-image-modal-overlay';
        modalOverlay.style.position = 'fixed';
        modalOverlay.style.top = '0';
        modalOverlay.style.left = '0';
        modalOverlay.style.width = '100%';
        modalOverlay.style.height = '100%';
        modalOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
        modalOverlay.style.backdropFilter = 'blur(5px)';
        modalOverlay.style.zIndex = '2000000';
        modalOverlay.style.display = 'flex';
        modalOverlay.style.justifyContent = 'center';
        modalOverlay.style.alignItems = 'center';

        // Create modal content
        const modal = document.createElement('div');
        modal.className = 'full-image-modal';
        modal.style.position = 'relative';
        modal.style.backgroundColor = 'var(--bg-primary)';
        modal.style.borderRadius = '16px';
        modal.style.boxShadow = 'var(--shadow-lg)';
        modal.style.zIndex = '2000001';
        modal.style.display = 'flex';
        modal.style.width = '90vw';
        modal.style.height = '90vh';
        modal.style.overflow = 'hidden';

        // Create split layout container
        const contentContainer = document.createElement('div');
        contentContainer.style.display = 'flex';
        contentContainer.style.width = '100%';
        contentContainer.style.height = '100%';

        // Image container (left side)
        const imageContainer = document.createElement('div');
        imageContainer.style.flex = '2';
        imageContainer.style.backgroundColor = 'var(--bg-secondary)';
        imageContainer.style.display = 'flex';
        imageContainer.style.alignItems = 'center';
        imageContainer.style.justifyContent = 'center';
        imageContainer.style.padding = '20px';
        imageContainer.style.position = 'relative';
        
        const image = document.createElement('img');
        image.src = imageUrl;
        image.style.maxWidth = '100%';
        image.style.maxHeight = '100%';
        image.style.objectFit = 'contain';
        image.style.borderRadius = '8px';
        imageContainer.appendChild(image);

        // Metadata container (right side)
        const metadataContainer = document.createElement('div');
        metadataContainer.style.flex = '1';
        metadataContainer.style.minWidth = '300px';
        metadataContainer.style.maxWidth = '400px';
        metadataContainer.style.padding = '30px';
        metadataContainer.style.borderLeft = '1px solid var(--glass-border)';
        metadataContainer.style.overflow = 'auto';

        // Add header with buttons
        const headerContainer = document.createElement('div');
        headerContainer.style.display = 'flex';
        headerContainer.style.justifyContent = 'space-between';
        headerContainer.style.alignItems = 'center';
        headerContainer.style.marginBottom = '20px';
        headerContainer.style.gap = '10px';

        // AI Insights button
        const aiButton = document.createElement('button');
        aiButton.textContent = '🤖 AI Insights';
        aiButton.style.padding = '8px 16px';
        aiButton.style.background = 'var(--accent-primary)';
        aiButton.style.color = 'white';
        aiButton.style.border = 'none';
        aiButton.style.borderRadius = '8px';
        aiButton.style.cursor = 'pointer';
        aiButton.style.flex = '1';
        aiButton.onclick = () => {
            console.log('AI Insights clicked');
            // Add AI insights functionality here
        };

        // Download Report button
        const downloadButton = document.createElement('button');
        downloadButton.textContent = '📥 Download Report';
        downloadButton.style.padding = '8px 16px';
        downloadButton.style.backgroundColor = 'var(--accent-secondary)';
        downloadButton.style.color = 'white';
        downloadButton.style.border = 'none';
        downloadButton.style.borderRadius = '8px';
        downloadButton.style.cursor = 'pointer';
        downloadButton.style.flex = '1';
        downloadButton.onclick = () => {
            console.log('Download Report clicked');
            // Add download functionality here
        };

        headerContainer.appendChild(aiButton);
        headerContainer.appendChild(downloadButton);
        metadataContainer.appendChild(headerContainer);

        // Add metadata content
        const title = document.createElement('h2');
        title.textContent = 'Image Details';
        title.style.color = 'var(--text-primary)';
        title.style.marginTop = '0';
        title.style.marginBottom = '20px';
        title.style.fontSize = '18px';
        metadataContainer.appendChild(title);

        // Helper function to create metadata sections
        const createMetadataSection = (label, value, color = 'var(--accent-primary)') => {
            const section = document.createElement('div');
            section.style.marginBottom = '15px';
            section.innerHTML = `
                <h3 style="color: ${color}; margin: 0 0 4px 0; font-size: 14px; text-shadow: 1px 1px 1px rgba(0,0,0,0.2);">${label}</h3>
                <p style="color: #000000; margin: 0; font-size: 13px; background-color: rgba(255, 255, 255, 0.9); padding: 8px 12px; border-radius: 4px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">${value || 'N/A'}</p>
            `;
            return section;
        };

        // Main Subject
        let mainSubject = submission.prompts?.mainSubject;
        if (!mainSubject && submission.mainSubject) {
            mainSubject = submission.mainSubject;
        }
        metadataContainer.appendChild(createMetadataSection('Main Subject', mainSubject));

        // Context
        let context = submission.prompts?.context;
        if (!context && submission.context) {
            context = submission.context;
        }
        metadataContainer.appendChild(createMetadataSection('Context', context));

        // Elements to Avoid
        let avoid = submission.prompts?.avoid;
        if (!avoid && submission.avoid) {
            avoid = submission.avoid;
        }
        metadataContainer.appendChild(createMetadataSection('Elements To Avoid', avoid));

        // Slider Values
        let sliderValues = submission.prompts?.sliderValues;
        if (!sliderValues && submission.sliderValues) {
            sliderValues = submission.sliderValues;
        }

        if (sliderValues) {
            const sliders = document.createElement('div');
            sliders.style.marginBottom = '15px';
            sliders.innerHTML = `
                <h3 style="color: var(--accent-primary); margin: 0 0 4px 0; font-size: 14px;">Preferences</h3>
            `;

            const sliderLabels = {
                sunlight: 'Natural Light',
                movement: 'Social/Privacy',
                privacy: 'Space Flexibility',
                harmony: 'Comfort/Atmosphere'
            };

            Object.entries(sliderValues).forEach(([key, value]) => {
                if (sliderLabels[key]) {
                    const slider = document.createElement('div');
                    slider.style.marginBottom = '4px';
                    slider.style.color = 'var(--text-primary)';
                    slider.style.fontSize = '13px';
                    slider.innerHTML = `${sliderLabels[key]}: ${value}%`;
                    sliders.appendChild(slider);
                }
            });
            metadataContainer.appendChild(sliders);
        }

        // Add voting buttons
        const votingContainer = document.createElement('div');
        votingContainer.style.display = 'flex';
        votingContainer.style.gap = '10px';
        votingContainer.style.marginTop = '20px';
        votingContainer.style.marginBottom = '20px';
        votingContainer.style.padding = '15px';
        votingContainer.style.backgroundColor = 'rgba(255, 255, 255, 0.9)';
        votingContainer.style.borderRadius = '8px';
        votingContainer.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';

        const upvoteButton = document.createElement('button');
        upvoteButton.innerHTML = `👍 Upvote (${votes?.upvotes || 0})`;
        upvoteButton.style.flex = '1';
        upvoteButton.style.padding = '10px';
        upvoteButton.style.backgroundColor = '#4CAF50';
        upvoteButton.style.color = 'white';
        upvoteButton.style.border = 'none';
        upvoteButton.style.borderRadius = '8px';
        upvoteButton.style.cursor = 'pointer';
        upvoteButton.style.fontWeight = 'bold';
        upvoteButton.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
        upvoteButton.onclick = async () => {
            const submissionId = submission.timestamp || submission.submittedAt;
            const result = await voteForSubmission(submissionId, 'up');
            upvoteButton.innerHTML = `👍 Upvote (${result.upvotes})`;
            downvoteButton.innerHTML = `👎 Downvote (${result.downvotes})`;
        };

        const downvoteButton = document.createElement('button');
        downvoteButton.innerHTML = `👎 Downvote (${votes?.downvotes || 0})`;
        downvoteButton.style.flex = '1';
        downvoteButton.style.padding = '10px';
        downvoteButton.style.backgroundColor = '#f44336';
        downvoteButton.style.color = 'white';
        downvoteButton.style.border = 'none';
        downvoteButton.style.borderRadius = '8px';
        downvoteButton.style.cursor = 'pointer';
        downvoteButton.style.fontWeight = 'bold';
        downvoteButton.style.boxShadow = '0 2px 4px rgba(0,0,0,0.1)';
        downvoteButton.onclick = async () => {
            const submissionId = submission.timestamp || submission.submittedAt;
            const result = await voteForSubmission(submissionId, 'down');
            upvoteButton.innerHTML = `👍 Upvote (${result.upvotes})`;
            downvoteButton.innerHTML = `👎 Downvote (${result.downvotes})`;
        };

        votingContainer.appendChild(upvoteButton);
        votingContainer.appendChild(downvoteButton);
        metadataContainer.appendChild(votingContainer);

        // Add edit button
        const editButton = document.createElement('button');
        editButton.innerHTML = '✏️ Edit Image';
        editButton.style.width = '100%';
        editButton.style.padding = '10px';
        editButton.style.backgroundColor = 'var(--accent-primary)';
        editButton.style.color = 'white';
        editButton.style.border = 'none';
        editButton.style.borderRadius = '8px';
        editButton.style.cursor = 'pointer';
        editButton.style.marginTop = '10px';
        editButton.onclick = () => {
            // First, close all modals and overlays
            const modals = document.querySelectorAll('.modal-overlay, .full-image-modal-overlay');
            modals.forEach(modal => modal.remove());
            
            // Reset the submissions view
            const submissionsView = document.getElementById('submissions-view');
            if (submissionsView) {
                submissionsView.style.display = 'none';
            }
            
            // Show the main interface elements
            const mainContent = document.querySelector('.main-content');
            if (mainContent) {
                mainContent.style.display = 'block';
            }
            
            // Show and reset the map container
            const mapContainer = document.getElementById('map');
            if (mapContainer) {
                mapContainer.style.display = 'block';
                // Trigger a resize event to ensure the map renders correctly
                if (window.google && window.google.maps) {
                    google.maps.event.trigger(map, 'resize');
                }
            }
            
            // Show the street view container
            const streetViewContainer = document.getElementById('street-view');
            if (streetViewContainer) {
                streetViewContainer.style.display = 'block';
            }
            
            // Create the proxied URL
            const proxyUrl = `/proxy-image?url=${encodeURIComponent(imageUrl)}`;
            
            // Load the image into the drawing canvas
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
                // Set flag to indicate image is from modal
                window.imageLoadedFromModal = true;
                
                // Initialize the drawing canvas with the loaded image
                initializeDrawingCanvas(img);
                
                // Switch to the drawing tab
                const drawingTab = document.querySelector('[data-tab="drawing"]');
                if (drawingTab) {
                    drawingTab.click();
                }
                
                // Update source image with contain fit
                const sourceImage = document.getElementById('source-image');
                if (sourceImage) {
                    // Do not modify the container size, just make the image fit
                    sourceImage.style.maxWidth = '100%';
                    sourceImage.style.maxHeight = '100%';
                    sourceImage.style.width = 'auto';
                    sourceImage.style.height = 'auto';
                    sourceImage.style.objectFit = 'contain';
                    sourceImage.style.display = 'block';
                    sourceImage.src = proxyUrl;
                }
                
                // Show and reset the drawing tools
                const drawingTools = document.getElementById('drawing-tools');
                if (drawingTools) {
                    drawingTools.style.display = 'flex';
                }
                
                // Ensure the layout is properly updated
                window.dispatchEvent(new Event('resize'));
            };
            
            // Handle load errors
            img.onerror = (error) => {
                console.error('Error loading image:', error);
                alert('Failed to load the image. Please try again.');
            };
            
            img.src = proxyUrl;
        };
        metadataContainer.appendChild(editButton);

        // Close button
        const closeButton = document.createElement('button');
        closeButton.innerHTML = '×';
        closeButton.style.position = 'absolute';
        closeButton.style.top = '10px';
        closeButton.style.right = '10px';
        closeButton.style.fontSize = '20px';
        closeButton.style.width = '30px';
        closeButton.style.height = '30px';
        closeButton.style.border = '1px solid var(--glass-border)';
        closeButton.style.borderRadius = '50%';
        closeButton.style.backgroundColor = 'var(--bg-primary)';
        closeButton.style.color = 'var(--text-primary)';
        closeButton.style.cursor = 'pointer';
        closeButton.style.display = 'flex';
        closeButton.style.alignItems = 'center';
        closeButton.style.justifyContent = 'center';
        closeButton.style.transition = 'all 0.2s ease';

        closeButton.onmouseover = function() {
            this.style.backgroundColor = 'var(--accent-primary)';
            this.style.color = 'white';
            this.style.transform = 'scale(1.1)';
        };
        closeButton.onmouseout = function() {
            this.style.backgroundColor = 'var(--bg-primary)';
            this.style.color = 'var(--text-primary)';
            this.style.transform = 'scale(1)';
        };

        // Close modal function
        const closeModal = () => {
            modalOverlay.remove();
        };

        // Add close handlers
        closeButton.onclick = closeModal;
        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) {
                closeModal();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeModal();
            }
        });

        // Assemble the modal
        contentContainer.appendChild(imageContainer);
        contentContainer.appendChild(metadataContainer);
        modal.appendChild(contentContainer);
        modal.appendChild(closeButton);
        modalOverlay.appendChild(modal);
        document.body.appendChild(modalOverlay);

    } catch (error) {
        console.error('Error showing full image modal:', error);
    }
}

// Helper function to style the info window with light theme
function styleInfoWindow() {
    try {
        // Add a small delay to ensure DOM elements are available
        setTimeout(() => {
            try {
                // Get the infowindow container with null checks
                const iwOuter = document.querySelector('.gm-style-iw-a');
                if (!iwOuter) {
                    console.log('Info window outer element not found yet');
                    return;
                }
                
                // Safely access next sibling with null check
                if (iwOuter.nextElementSibling) {
                    iwOuter.nextElementSibling.style.display = 'none'; // Hide the default close button
                }
                
                // Find the inner container and style it with null checks
                const iwBackground = iwOuter.querySelector('.gm-style-iw-t');
                if (iwBackground) {
                    iwBackground.style.backgroundColor = 'var(--bg-primary)';
                    if (iwBackground.parentElement) {
                        iwBackground.parentElement.style.backgroundColor = 'var(--bg-primary)';
                    }
                }
                
                // Find all the divs inside the info window and style them with null checks
                const iwContainer = document.querySelector('.gm-style-iw');
                if (iwContainer) {
                    iwContainer.style.backgroundColor = 'var(--bg-primary)';
                    iwContainer.style.padding = '0px';
                    iwContainer.style.borderRadius = 'var(--bento-radius)';
                    iwContainer.style.border = '1px solid var(--glass-border)';
                    iwContainer.style.boxShadow = 'var(--shadow-lg)';
                    
                    // Style the overflow container with null check
                    const iwContent = iwContainer.querySelector('.gm-style-iw-d');
                    if (iwContent) {
                        iwContent.style.backgroundColor = 'var(--bg-primary)';
                        iwContent.style.color = 'var(--text-primary)';
                        iwContent.style.overflow = 'auto'; // Change from 'hidden' to 'auto' to allow scrolling
                        iwContent.style.maxHeight = 'none !important';
                        
                        // Remove any max-height restrictions that might be applied inline
                        iwContent.style.removeProperty('max-height');
                        
                        // Ensure there's enough height for scrolling when needed
                        const contentHeight = iwContent.scrollHeight;
                        if (contentHeight > 400) {
                            iwContent.style.maxHeight = '400px';
                            iwContent.style.overflowY = 'scroll';
                        }
                    }
                }
                
                console.log('Info window styling completed with light theme');
            } catch (innerError) {
                console.error('Error in delayed styling of info window:', innerError);
            }
        }, 100); // Small delay to ensure DOM is ready
    } catch (error) {
        console.error('Error styling info window:', error);
    }
}

// Update handleMouseMove function to use different scaling factor based on image source
function handleMouseMove(e) {
    if (!isDrawing) return;
    
    // Get properly scaled coordinates
    const coords = getScaledCoordinates(e, maskCanvas);
    const x = coords.x;
    const y = coords.y;
    
    // Update mouseX and mouseY for cursor positioning
    mouseX = e.clientX;
    mouseY = e.clientY;
    
    // Use requestAnimationFrame for smoother drawing
    requestAnimationFrame(() => {
        // Calculate scaled brush size based on image dimensions
        let scaledBrushSize = brushSize;
        
        // Apply the brush size factor (1-10 scale to pixels)
        const brushSizeFactor = 10;
        scaledBrushSize = scaledBrushSize * brushSizeFactor;
        
        if (originalImage && maskCanvas) {
            const canvasAspect = maskCanvas.width / maskCanvas.height;
            const imageAspect = originalImage.width / originalImage.height;
            
            // Scale the brush size based on image-to-canvas ratio
            if (imageAspect > canvasAspect) {
                // Image is constrained by width
                const scale = maskCanvas.width / originalImage.width;
                // Apply different scaling factors based on image source
                if (imageLoadedFromModal) {
                    scaledBrushSize = scaledBrushSize * scale * 3; // Triple for modal images
                } else {
                    scaledBrushSize = scaledBrushSize * scale * 2; // Double for street view
                }
            } else {
                // Image is constrained by height
                const scale = maskCanvas.height / originalImage.height;
                // Apply different scaling factors based on image source
                if (imageLoadedFromModal) {
                    scaledBrushSize = scaledBrushSize * scale * 3; // Triple for modal images
                } else {
                    scaledBrushSize = scaledBrushSize * scale * 2; // Double for street view
                }
            }
        }
        
        // Draw a line segment from the last position to the current position
        maskCtx.beginPath();
        maskCtx.moveTo(lastX, lastY);
        maskCtx.lineTo(x, y);
        
        // Set drawing properties
        if (currentTool === 'eraser') {
            maskCtx.globalCompositeOperation = 'destination-out';
            maskCtx.strokeStyle = 'rgba(0, 0, 0, 1)';
        } else {
            // First clear the area we're about to draw in
            maskCtx.save();
            maskCtx.globalCompositeOperation = 'destination-out';
            maskCtx.lineWidth = scaledBrushSize;
            maskCtx.lineCap = 'round';
            maskCtx.lineJoin = 'round';
            maskCtx.stroke();
            maskCtx.restore();
            
            // Use 'copy' blend mode to replace pixels without accumulating transparency
            maskCtx.globalCompositeOperation = 'source-over';
            
            // Use full color with fixed alpha to avoid transparency buildup
            const fixedAlpha = 0.1; // Fixed 10% transparency
            let brushColor;
            
            if (userColor) {
                // Convert hex color to RGB with fixed alpha
                const r = parseInt(userColor.slice(1, 3), 16);
                const g = parseInt(userColor.slice(3, 5), 16);
                const b = parseInt(userColor.slice(5, 7), 16);
                brushColor = `rgba(${r}, ${g}, ${b}, ${fixedAlpha})`;
            } else {
                brushColor = 'rgba(255, 0, 0, 0.1)'; // Default red with fixed alpha
            }
            
            maskCtx.strokeStyle = brushColor;
        }
        
        maskCtx.lineWidth = scaledBrushSize;
        maskCtx.lineCap = 'round';
        maskCtx.lineJoin = 'round';
        maskCtx.stroke();
        
        // Reset composite operation
        maskCtx.globalCompositeOperation = 'source-over';
        
        // Emit brush stroke to other users
        if (socket && socket.connected) {
            socket.emit('brush_stroke', {
                x, y, lastX, lastY,
                brushSize: scaledBrushSize,
                tool: currentTool,
                canvasWidth: maskCanvas.width,
                canvasHeight: maskCanvas.height,
                isFromModal: imageLoadedFromModal
            });
        }
        
        // Update cursor with current mouse position
        updateCursor(e);
    });
    
    // Update last position
    lastX = x;
    lastY = y;
}

// IMPORTANT: Make key functions globally available
// Add initializeBrushCursor function
function initializeBrushCursor() {
    if (!cursorCanvas || !cursorCtx) {
        console.error('Cursor canvas not initialized');
        return;
    }
    
    // Clear any existing cursor
    cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
    
    // Draw the initial cursor if we know the mouse position
    if (lastX !== null && lastY !== null) {
        updateCursor({ clientX: lastX, clientY: lastY });
    }
}

// Make critical functions globally available
window.initializeBrushCursor = initializeBrushCursor;
window.initializeDrawingCanvas = initializeDrawingCanvas;
window.updateStreetView = updateStreetView;
window.initializeWebSocket = initializeWebSocket;

// Add a function to check if the map is ready and wait if needed
async function waitForMapToInitialize(timeout = 5000) {
    const startTime = Date.now();
    
    // If the section is hidden, show it first
    const streetViewSection = document.getElementById('streetViewSection');
    if (streetViewSection && streetViewSection.classList.contains('hidden')) {
        console.log('Street View section is hidden, showing it first');
        if (window.showStreetViewSection) {
            window.showStreetViewSection();
            // Give time for the section to become visible and map to initialize
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    while (!map && Date.now() - startTime < timeout) {
        console.log('Waiting for map to initialize...');
        
        // Get the latest map from window.map (which should be set in initMap)
        map = window.map;
        
        // If still no map but the section is visible, try to initialize it directly
        if (!map && streetViewSection && !streetViewSection.classList.contains('hidden')) {
            const mapElement = document.getElementById('map');
            if (mapElement && !window.mapInitialized) {
                console.log('Attempting to initialize map directly...');
                
                // Create a new map instance
        const mapOptions = {
            center: { lat: 40.7128, lng: -74.0060 },
            zoom: 12,
                    styles: window.mapStyles || []
                };
                
                try {
                    window.map = new google.maps.Map(mapElement, mapOptions);
                    map = window.map;
                    window.mapInitialized = true;
                    console.log('Map initialized successfully');
                    break;
                } catch (error) {
                    console.error('Error initializing map:', error);
                }
            }
        }
        
        if (map) break;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    if (!map) {
        console.error('Map initialization timed out');
        return false;
    }
    
    return true;
}

// Update the updateStreetView function and make it global
async function updateStreetView(location) {
    if (!location) return;
    
    console.log('Updating Street View for location:', location);
    
    // Wait for map to initialize if not ready
    if (!map) {
        const mapReady = await waitForMapToInitialize();
        if (!mapReady) {
            console.error('Could not update Street View - map not initialized');
            alert('Map is not available. Please try refreshing the page.');
            return;
        }
    }
    
    // Update the map center and marker
    if (map) {
        map.setCenter(location);
        map.setZoom(15);
        
        if (currentMarker) {
            currentMarker.setMap(null);
        }
        
        currentMarker = new google.maps.Marker({
            map: map,
            position: location,
            draggable: true
        });
        
        // Add drag end listener to update Street View
        currentMarker.addListener('dragend', () => {
            console.log('Marker dragged to new position:', currentMarker.getPosition());
            loadStreetViewImage(currentMarker.getPosition());
        });
        
        // Load the Street View image first to get the panorama ID and heading
        const streetViewUrl = await loadStreetViewImage(location);
        
        // Only emit location update if we successfully loaded the Street View image
        if (streetViewUrl && socket && socket.connected) {
            // The loadStreetViewImage function will handle emitting the location update
            // with the panorama ID and heading
            console.log('Street View image loaded successfully, location update will be emitted by loadStreetViewImage');
        } else {
            console.error('Failed to load Street View image or socket not connected');
        }
    } else {
        console.error('Map not initialized');
    }
}

// Make updateStreetView function available globally
window.updateStreetView = updateStreetView;

// Function to initialize drawing canvas and make it global
function initializeDrawingCanvas(image = null) {
    try {
        if (!image) {
            console.log('No image provided to initializeDrawingCanvas - initializing empty canvas');
            return;
        }
        
        console.log('🖌️ Initializing drawing canvas with image:', image.width, 'x', image.height);
        
        // Store the original image for scaling calculations
        originalImage = image;

        const editorContainer = document.getElementById('editor-container');
        if (!editorContainer) {
            throw new Error('Editor container not found');
        }

        // Clear existing canvases if present
        const existingCanvases = editorContainer.querySelectorAll('canvas');
        if (existingCanvases.length > 0) {
            console.log('🖌️ Clearing existing canvases:', existingCanvases.length);
            existingCanvases.forEach(canvas => {
                editorContainer.removeChild(canvas);
            });
        }

        // Create fresh canvas elements
        imageCanvas = document.createElement('canvas');
        imageCanvas.className = 'base-canvas';
        
        maskCanvas = document.createElement('canvas');
        maskCanvas.className = 'drawing-canvas';
        
        cursorCanvas = document.createElement('canvas');
        cursorCanvas.className = 'cursor-canvas';

        // Set up the canvas contexts
        imageCtx = imageCanvas.getContext('2d');
        maskCtx = maskCanvas.getContext('2d');
        cursorCtx = cursorCanvas.getContext('2d');

        // Use the container's original dimensions
        const containerWidth = editorContainer.offsetWidth;
        const containerHeight = editorContainer.offsetHeight;
        
        // Calculate scale to fit image within container while maintaining aspect ratio
        const imageAspect = image.width / image.height;
        const containerAspect = containerWidth / containerHeight;
        
        let scaledWidth, scaledHeight;
        
        if (imageAspect > containerAspect) {
            // Image is wider than container aspect ratio
            scaledWidth = containerWidth;
            scaledHeight = containerWidth / imageAspect;
        } else {
            // Image is taller than container aspect ratio
            scaledHeight = containerHeight;
            scaledWidth = containerHeight * imageAspect;
        }

        // Apply dimensions to all canvases
        [imageCanvas, maskCanvas, cursorCanvas].forEach(canvas => {
            canvas.width = scaledWidth;
            canvas.height = scaledHeight;
            canvas.style.position = 'absolute';
            canvas.style.left = '50%';
            canvas.style.top = '50%';
            canvas.style.transform = 'translate(-50%, -50%)';
            editorContainer.appendChild(canvas);
        });

        // Draw the image
        console.log('🖌️ Drawing image to canvas');
        imageCtx.clearRect(0, 0, scaledWidth, scaledHeight);
        imageCtx.drawImage(image, 0, 0, scaledWidth, scaledHeight);
        
        // Clear the mask canvas
        maskCtx.clearRect(0, 0, scaledWidth, scaledHeight);
        
        // Clear cursor canvas
        cursorCtx.clearRect(0, 0, scaledWidth, scaledHeight);
        
        // Store the current image
        currentImage = image;

        // Add mouse move event to update cursor
        maskCanvas.addEventListener('mousemove', function(e) {
            mouseX = e.clientX;
            mouseY = e.clientY;
            updateCursor(e);
        });

        // Add event listeners for drawing
        maskCanvas.addEventListener('mousedown', startDrawing);
        maskCanvas.addEventListener('mousemove', handleMouseMove);
        maskCanvas.addEventListener('mouseup', stopDrawing);
        maskCanvas.addEventListener('mouseleave', handleMouseLeave);
        maskCanvas.addEventListener('mouseenter', handleMouseEnter);
        
        // Initialize brush cursor
        initializeBrushCursor();
        
        // Make sure cursor shows up immediately if mouse is already over canvas
        if (mouseX !== null && mouseY !== null) {
            const canvasRect = maskCanvas.getBoundingClientRect();
            if (
                mouseX >= canvasRect.left && 
                mouseX <= canvasRect.right && 
                mouseY >= canvasRect.top && 
                mouseY <= canvasRect.bottom
            ) {
                updateCursor({ clientX: mouseX, clientY: mouseY });
            }
        }
        
        console.log('🖌️ Drawing canvas initialized successfully');
        return true;
    } catch (error) {
        console.error('❌ Error initializing drawing canvas:', error);
        return false;
    }
}

// Add initializeUIElements function
function initializeUIElements() {
    console.log('Initializing UI elements');
    
    // Initialize load image button
    const loadImageBtn = document.getElementById('load-view-btn');
    if (loadImageBtn) {
        console.log('Setting up Load Image button click handler');
        loadImageBtn.addEventListener('click', function() {
            console.log('Load Image button clicked');
            openImageSelectionModal();
        });
    } else {
        console.warn('Load Image button not found');
    }
    
    // Initialize Street View button
    const loadStreetViewBtn = document.getElementById('load-streetview-btn');
    const streetViewSection = document.getElementById('streetViewSection');
    if (loadStreetViewBtn && streetViewSection) {
        console.log('Setting up Load Street View button click handler');
        loadStreetViewBtn.addEventListener('click', function() {
            console.log('Load Street View button clicked');
            // Use the safer function defined in index.html
            if (window.showStreetViewSection) {
                window.showStreetViewSection();
            } else {
                // Fallback if the helper function is not available
                streetViewSection.classList.remove('hidden');
            }
        });
    } else {
        console.warn('Load Street View button or section not found');
    }
    
    // Initialize View Submissions button
    const viewSubmissionsBtn = document.getElementById('viewSubmissionsBtn');
    if (viewSubmissionsBtn) {
        console.log('Setting up View Submissions button click handler');
        // Use direct function assignment instead of addEventListener to ensure it's always the latest version
        viewSubmissionsBtn.onclick = function() {
            console.log('View Submissions button clicked');
            openSubmissionsModal();
            return false; // Prevent default
        };
        console.log('View Submissions button handler set');
    } else {
        console.error('View submissions button not found'); // Change to error to highlight
    }
    
    // Initialize How to Use button
    const howToUseBtn = document.getElementById('howToUseBtn');
    if (howToUseBtn) {
        console.log('Setting up How to Use button click handler');
        howToUseBtn.addEventListener('click', function() {
            console.log('How to Use button clicked');
            openHowToUseModal();
        });
    } else {
        console.warn('How to Use button not found');
    }
    
    // Initialize brush tools
    initializeBrushTools();
    
    // Initialize generate button
    const generateButton = document.getElementById('generate-button');
    if (generateButton) {
        generateButton.addEventListener('click', function() {
            console.log('Generate button clicked');
            generateImage();
        });
    }
    
    console.log('UI elements initialized');
}

// Function to initialize tab navigation
function initializeTabNavigation() {
    console.log('Initializing tab navigation');
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');
    
    // Initially hide all tab panes and set their display to none
    tabPanes.forEach(pane => {
        pane.classList.remove('active');
        pane.style.display = 'none';
    });
    
    // Activate the first tab if it exists
    if (tabButtons.length > 0 && tabPanes.length > 0) {
        const firstTabId = tabButtons[0].getAttribute('data-tab');
        tabButtons[0].classList.add('active');
        const firstTabPane = document.getElementById(`${firstTabId}-tab`);
        if (firstTabPane) {
            firstTabPane.classList.add('active');
            firstTabPane.style.display = 'flex';
        }
    }
    
    tabButtons.forEach(button => {
        button.addEventListener('click', function() {
            // Get the tab to show
            const tabId = this.getAttribute('data-tab');
            console.log('Tab clicked:', tabId);
            
            // Remove active class from all buttons and hide all panes
            tabButtons.forEach(btn => btn.classList.remove('active'));
            tabPanes.forEach(pane => {
                pane.classList.remove('active');
                pane.style.display = 'none';
            });
            
            // Add active class to current button and pane
            this.classList.add('active');
            const tabPane = document.getElementById(`${tabId}-tab`);
            if (tabPane) {
                tabPane.classList.add('active');
                tabPane.style.display = 'flex';
            } else {
                console.error(`Tab pane not found for ID: ${tabId}-tab`);
            }
        });
    });
    
    console.log('Tab navigation initialized');
}

// Update the DOMContentLoaded event listener
document.addEventListener('DOMContentLoaded', async function() {
    console.log('DOM loaded - script.js initialization starting');
    
    try {
        // Initialize WebSocket connection first
        console.log('Initializing WebSocket connection...');
        initializeWebSocket();

        // Initialize connected users button
        const connectedUsersBtn = document.getElementById('connectedUsersBtn');
        if (connectedUsersBtn) {
            // Initialize button text
            connectedUsersBtn.innerHTML = `
                Collaborators (0)
                <span class="status-dot status-disconnected"></span>
            `;
        }

        // Clear any existing mask canvas
        const editorContainer = document.getElementById('editor-container');
        if (editorContainer) {
            editorContainer.innerHTML = '';
        }
        
        // Reset global canvas variables
        maskCanvas = null;
        maskCtx = null;
        imageCanvas = null;
        imageCtx = null;
        cursorCanvas = null;
        cursorCtx = null;
        currentImage = null;
        
        // Load the cursor images
        const cursorImages = await loadBrushCursorImage();
        brushCursorImage = cursorImages.brush;
        eraserCursorImage = cursorImages.eraser;
        
        // Initialize tab navigation
        initializeTabNavigation();
        
        // Initialize sliders first
        console.log('Initializing sliders...');
        initializeSliders();
        
        // Initialize image selection modal
        initializeImageSelectionModal();
        
        // Initialize all UI elements
        initializeUIElements();
        
        // Set up event listeners for user text input in prompt areas
        const mainSubjectPrompt = document.getElementById('main-subject-prompt');
        const contextPrompt = document.getElementById('context-prompt');
        const avoidPrompt = document.getElementById('avoid-prompt');
        
        if (mainSubjectPrompt && contextPrompt && avoidPrompt) {
            // Store initial user text
            mainSubjectPrompt.dataset.userText = mainSubjectPrompt.value || '';
            contextPrompt.dataset.userText = contextPrompt.value || '';
            
            // Listen for user input to update the stored user text
            mainSubjectPrompt.addEventListener('input', function() {
                mainSubjectPrompt.dataset.userText = this.value;
                // Re-apply slider contributions
                updatePromptsFromSliders();
            });
            
            contextPrompt.addEventListener('input', function() {
                contextPrompt.dataset.userText = this.value;
                // Re-apply slider contributions
                updatePromptsFromSliders();
            });
        }
        
        console.log('Script.js initialization complete');

    } catch (error) {
        console.error('Error in DOMContentLoaded:', error);
        updateConnectionStatus(false);
    }
});

// Make sure openImageSelectionModal is correctly defined and globally available
window.openImageSelectionModal = openImageSelectionModal;

// Function to initialize WebSocket connection
function initializeWebSocket() {
    try {
        socket = io(window.location.origin, {
            transports: ['websocket'],
            upgrade: false,
            reconnection: true,
            reconnectionAttempts: 5
        });

        socket.on('connect', () => {
            console.log('Connected to server');
            updateConnectionStatus(true);
            userId = socket.id;
            // Request submissions when connected
            socket.emit('get_submissions');
        });

        socket.on('user_connected', (data) => {
            console.log('User connected:', data);
            // Store the color for this user
            connectedUserColors.set(data.user_id, data.color);
            if (data.user_id !== socket.id) {  // Only add other users to connectedUsers
                connectedUsers.set(data.user_id, {
                    color: data.color,
                    brush_size: data.brush_size
                });
            }
            updateUsersList();
        });

        socket.on('users_list', (data) => {
            console.log('Received users list:', data);
            connectedUsers.clear();
            connectedUserColors.clear();
            data.users.forEach(user => {
                // Store color for all users including self
                connectedUserColors.set(user.id, user.color);
                if (user.id !== socket.id) {  // Only add other users to connectedUsers
                    connectedUsers.set(user.id, {
                        color: user.color,
                        brush_size: user.brush_size,
                        connected_at: user.connected_at
                    });
                }
            });
            updateUsersList();
        });

        socket.on('brush_stroke', (data) => {
            console.log('Received brush stroke:', data);
            if (!maskCanvas || !maskCtx) return;

            // Get the user's color
            const userColor = data.color || '#FF0000';
            const brushSize = data.brushSize || 5;
            const isEraser = data.tool === 'eraser';

            // Set up the drawing context
            if (isEraser) {
                maskCtx.globalCompositeOperation = 'destination-out';
                maskCtx.strokeStyle = 'rgba(0, 0, 0, 1)';
            } else {
                maskCtx.globalCompositeOperation = 'source-over';
                const fixedAlpha = 0.1;
                const r = parseInt(userColor.slice(1, 3), 16);
                const g = parseInt(userColor.slice(3, 5), 16);
                const b = parseInt(userColor.slice(5, 7), 16);
                maskCtx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${fixedAlpha})`;
            }

            // Draw the stroke
            maskCtx.beginPath();
            maskCtx.moveTo(data.x, data.y);
            maskCtx.lineTo(data.lastX, data.lastY);
            maskCtx.lineWidth = brushSize;
            maskCtx.lineCap = 'round';
            maskCtx.lineJoin = 'round';
            maskCtx.stroke();

            // Reset composite operation
            maskCtx.globalCompositeOperation = 'source-over';

            // Store the user's last position
            const user = connectedUsers.get(data.user_id);
            if (user) {
                user.lastX = data.x;
                user.lastY = data.y;
                
                // Update the bubble position if it exists
                const bubble = userDrawingBubbles.get(data.user_id);
                if (bubble && maskCanvas) {
                    const rect = maskCanvas.getBoundingClientRect();
                    const scaleX = maskCanvas.width / rect.width;
                    const scaleY = maskCanvas.height / rect.height;
                    
                    // Convert canvas coordinates to screen coordinates
                    const screenX = rect.left + (data.x / scaleX);
                    const screenY = rect.top + (data.y / scaleY);
                    
                    bubble.style.left = `${screenX}px`;
                    bubble.style.top = `${screenY}px`;
                }
            }
        });

        socket.on('brush_size_updated', (data) => {
            console.log('Brush size updated:', data);
            if (data.user_id !== socket.id) {
                const user = connectedUsers.get(data.user_id);
                if (user) {
                    user.brush_size = data.size;
                }
            }
        });

        socket.on('location_updated', (data) => {
            console.log('Received location update:', data);
            if (data.location && data.panorama_id && data.heading) {
                // Update the map center and marker
                if (map) {
                    map.setCenter(data.location);
                    map.setZoom(15);
                    
                    if (currentMarker) {
                        currentMarker.setMap(null);
                    }
                    
                    currentMarker = new google.maps.Marker({
                        map: map,
                        position: data.location,
                        draggable: true
                    });
                    
                    // Load the Street View image
                    loadStreetViewImage(data.location, data.panorama_id, data.heading);
                }
            }
        });

        socket.on('image_uploaded', (data) => {
            console.log('Received image upload:', data);
            if (data.imageUrl) {
                // Create a new image and load it
                const img = new Image();
                img.crossOrigin = "anonymous";
                
                img.onload = async () => {
                    console.log('Image loaded successfully:', img.width, 'x', img.height);
                    // Initialize the drawing canvas with the loaded image
                    await initializeDrawingCanvas(img);
                };
                
                img.onerror = (error) => {
                    console.error('Error loading image:', error);
                };
                
                img.src = data.imageUrl;
            }
        });

        socket.on('image_generated', (data) => {
            console.log('Received generated image:', data);
            if (data.image_url) {
                // Create a new image and load it
                const img = new Image();
                img.crossOrigin = "anonymous";
                
                img.onload = async () => {
                    console.log('Generated image loaded successfully:', img.width, 'x', img.height);
                    
                    // Update the preview container
                    const previewContainer = document.getElementById('preview-container');
                    if (previewContainer) {
                        previewContainer.innerHTML = '';
                        previewContainer.appendChild(img);
                    }
                    
                    // Store the generated image URL
                    generatedImageUrl = data.image_url;
                    
                    // Enable the submit button if it exists
                    const submitBtn = document.getElementById('submit-to-map-btn');
                    if (submitBtn) {
                        submitBtn.disabled = false;
                    }
                    
                    // Only update prompts if this is the user who generated the image
                    if (data.user_id === socket.id) {
                        if (data.prompt) {
                            const mainSubjectPrompt = document.getElementById('main-subject-prompt');
                            if (mainSubjectPrompt) {
                                mainSubjectPrompt.value = data.prompt;
                            }
                        }
                        
                        if (data.negative_prompt) {
                            const avoidPrompt = document.getElementById('avoid-prompt');
                            if (avoidPrompt) {
                                avoidPrompt.value = data.negative_prompt;
                            }
                        }
                    }
                    
                    // Initialize the drawing canvas with the loaded image
                    await initializeDrawingCanvas(img);
                };
                
                img.onerror = (error) => {
                    console.error('Error loading generated image:', error);
                    const previewContainer = document.getElementById('preview-container');
                    if (previewContainer) {
                        previewContainer.innerHTML = '<div class="error">Error loading generated image</div>';
                    }
                };
                
                // Use the proxy-image route to avoid CORS issues
                const proxiedImageUrl = `/proxy-image?url=${encodeURIComponent(data.image_url)}`;
                img.src = proxiedImageUrl;
            }
        });

        socket.on('disconnect', () => {
            updateConnectionStatus(false);
        });

        socket.on('user_drawing', (data) => {
            const { user_id, color, is_drawing } = data;
            
            if (is_drawing) {
                // Create or update the drawing bubble
                let bubble = userDrawingBubbles.get(user_id);
                if (!bubble) {
                    bubble = document.createElement('div');
                    bubble.className = 'drawing-bubble';
                    bubble.style.color = color; // Use the color for the border
                    bubble.textContent = `User ${user_id.slice(0, 4)}`;
                    document.body.appendChild(bubble);
                    userDrawingBubbles.set(user_id, bubble);
                }
                
                // Position the bubble near the user's cursor
                const user = connectedUsers.get(user_id);
                if (user && user.lastX && user.lastY && maskCanvas) {
                    const rect = maskCanvas.getBoundingClientRect();
                    const scaleX = maskCanvas.width / rect.width;
                    const scaleY = maskCanvas.height / rect.height;
                    
                    // Convert canvas coordinates to screen coordinates
                    const screenX = rect.left + (user.lastX / scaleX);
                    const screenY = rect.top + (user.lastY / scaleY);
                    
                    bubble.style.left = `${screenX}px`;
                    bubble.style.top = `${screenY}px`;
                }
            } else {
                // Remove the drawing bubble
                const bubble = userDrawingBubbles.get(user_id);
                if (bubble) {
                    bubble.remove();
                    userDrawingBubbles.delete(user_id);
                }
            }
        });

        socket.on('mask_cleared', (data) => {
            const { user_id, color } = data;
            console.log(`User ${user_id} cleared the mask`);
            
            // Clear the mask canvas
            if (maskCanvas && maskCtx) {
                maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
            }
        });
    } catch (error) {
        console.error('Error initializing WebSocket:', error);
    }
}

// Function to update connection status UI
function updateConnectionStatus(isConnected) {
    const connectedUsersBtn = document.getElementById('connectedUsersBtn');
    if (connectedUsersBtn) {
        // Add 1 to include the current user
        const userCount = connectedUsers.size + 1;
        
        // Get our color from the connectedUserColors map
        let userColor = socket && socket.id ? connectedUserColors.get(socket.id) : userColors.others[0];
        
        // If we don't have a color assigned yet, use the first color from userColors.others
        if (!userColor) {
            userColor = userColors.others[0];
        }
        
        connectedUsersBtn.innerHTML = `
            Collaborators (${userCount})
            <span class="status-dot" style="background-color: ${userColor};"></span>
        `;
    }
}

// Update the users list display
function updateUsersList() {
    const connectedUsersBtn = document.getElementById('connectedUsersBtn');
    if (!connectedUsersBtn) return;

    // Count all users including self
    const totalUsersCount = connectedUsers.size + 1;  // Add 1 for current user
    
    // Get our color from the connectedUserColors map
    let userColor = connectedUserColors.get(socket.id);
    
    // If we don't have a color assigned yet, use the first color from userColors.others
    if (!userColor) {
        userColor = userColors.others[0];
    }
    
    connectedUsersBtn.innerHTML = `
        Collaborators (${totalUsersCount})
        <span class="status-dot" style="background-color: ${userColor};"></span>
    `;
}

// Function to open the image selection modal
function openImageSelectionModal() {
    try {
        console.log('Opening image selection modal');
        const modal = document.getElementById('imageSelectionModal');
        if (!modal) {
            console.error('Image selection modal not found');
            return;
        }
        
        modal.style.display = 'block';
        
        // Add click handlers to image items
        const imageItems = document.querySelectorAll('.image-item');
        imageItems.forEach(item => {
            item.addEventListener('click', async () => {
                try {
                    // Remove selected class from all items
                    imageItems.forEach(i => i.classList.remove('selected'));
                    
                    // Add selected class to clicked item
                    item.classList.add('selected');
                    
                    // Get the image source from the data attribute
                    const imageSrc = item.getAttribute('data-image');
                    if (!imageSrc) {
                        throw new Error('No image source found in selected item');
                    }
                    
                    console.log('🖼️ Loading image from:', imageSrc);
                    
                    // Set the flag to indicate image is loaded from modal
                    imageLoadedFromModal = true;
                    console.log('🖼️ Set imageLoadedFromModal to true');
                    
                    // Get the image label too
                    const imageLabel = item.querySelector('.image-label');
                    const labelText = imageLabel ? imageLabel.textContent : 'Image';
                    
                    // Create a new image and load it
                    const img = new Image();
                    img.crossOrigin = "anonymous";
                    
                    // Wait for the image to load
                    await new Promise((resolve, reject) => {
                        img.onload = () => {
                            console.log('🖼️ Image loaded successfully:', img.width, 'x', img.height);
                            resolve();
                        };
                        img.onerror = (error) => {
                            console.error('❌ Error loading image:', error);
                            reject(new Error(`Failed to load image: ${error.message || 'Unknown error'}`));
                        };
                        img.src = imageSrc;
                    });
                    
                    // Initialize the drawing canvas with the loaded image
                    await initializeDrawingCanvas(img);
                    
                    // Emit the image to other connected browsers with proper flags
                    if (socket && socket.connected) {
                        console.log('🖼️ Broadcasting selected image to other users');
                        socket.emit('image_upload', {
                            imageUrl: imageSrc, // Use the same key name as in server handler
                            image_url: imageSrc, // For backward compatibility
                            user_id: socket.id,
                            is_modal_image: true,
                            label: labelText
                        });
                    }
                    
                    // Close the modal
                    closeImageSelectionModal();
                    
                                } catch (error) {
                    console.error('❌ Error selecting image:', error);
                    alert('Failed to load the selected image. Please try again.');
                }
            });
        });
    } catch (error) {
        console.error('❌ Error opening image selection modal:', error);
    }
}

// Function to close the image selection modal
function closeImageSelectionModal() {
    try {
        const modal = document.getElementById('imageSelectionModal');
        if (modal) {
            modal.style.display = 'none';
        }
    } catch (error) {
        console.error('Error closing image selection modal:', error);
    }
}

// Make these functions available globally
window.updateConnectionStatus = updateConnectionStatus;
window.updateUsersList = updateUsersList;
window.openImageSelectionModal = openImageSelectionModal;
window.closeImageSelectionModal = closeImageSelectionModal;

// The rest of your existing code follows...

// Function to initialize image selection modal
function initializeImageSelectionModal() {
    try {
        console.log('Initializing image selection modal');
        const modal = document.getElementById('imageSelectionModal');
        if (!modal) {
            console.error('Image selection modal not found');
            return;
        }
        
        // Add close button functionality
        const closeButton = modal.querySelector('.close-modal');
        if (closeButton) {
            closeButton.addEventListener('click', closeImageSelectionModal);
        }
        
        // Initialize the image grid
        const imageGrid = document.getElementById('imageGrid');
        if (!imageGrid) {
            console.warn('Image grid not found');
        }
        
        console.log('Image selection modal initialized');
        } catch (error) {
        console.error('Error initializing image selection modal:', error);
    }
}

// Function to initialize brush tools with updated brush preview scaling
function initializeBrushTools() {
    try {
        console.log('Initializing brush tools');
        
        // Set up tool buttons
        const brushBtn = document.getElementById('brush-btn');
        const eraserBtn = document.getElementById('eraser-btn');
        const clearBtn = document.getElementById('clear-btn');
        const brushSizeInput = document.getElementById('brush-size');
        
        // Initialize brush size
        if (brushSizeInput) {
            brushSize = parseInt(brushSizeInput.value) || 5;
            console.log('Initial brush size set to:', brushSize);
            
            // Update brush size label
            const brushSizeLabel = document.getElementById('brush-size-label');
            if (brushSizeLabel) {
                brushSizeLabel.textContent = `${brushSize}px`;
            }
            
            // Flag to control brush preview circle visibility
            window.showBrushPreview = false;
            
            // Function to show brush size preview in center of canvas
            const showBrushPreviewInCenter = () => {
                if (cursorCanvas && cursorCtx && maskCanvas) {
                    window.showBrushPreview = true;
                    
                    // Clear previous cursor
                    cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
                    
                    // Calculate center of canvas
                    const canvasX = cursorCanvas.width / 2;
                    const canvasY = cursorCanvas.height / 2;
                    
                    // Get current brush size (scaled to canvas dimensions)
                    let scaledBrushSize = brushSize;
                    
                    // Apply brush size factor
                    const brushSizeFactor = 10;
                    scaledBrushSize = scaledBrushSize * brushSizeFactor;
                    
                    // Scale based on image dimensions
                    if (currentImage && maskCanvas) {
                        const canvasAspect = maskCanvas.width / maskCanvas.height;
                        const imageAspect = currentImage.width / currentImage.height;
                        
                        if (imageAspect > canvasAspect) {
                            // Image is constrained by width
                            const scale = maskCanvas.width / currentImage.width;
                            // Apply different scaling factors based on image source
                            if (imageLoadedFromModal) {
                                scaledBrushSize = scaledBrushSize * scale * 3; // Triple for modal images
                            } else {
                                scaledBrushSize = scaledBrushSize * scale * 2; // Double for street view
                            }
                        } else {
                            // Image is constrained by height
                            const scale = maskCanvas.height / currentImage.height;
                            // Apply different scaling factors based on image source
                            if (imageLoadedFromModal) {
                                scaledBrushSize = scaledBrushSize * scale * 3; // Triple for modal images
                            } else {
                                scaledBrushSize = scaledBrushSize * scale * 2; // Double for street view
                            }
                        }
                    }
                    
                    // Draw a preview circle in the center of the canvas
                    cursorCtx.beginPath();
                    cursorCtx.arc(canvasX, canvasY, scaledBrushSize/2, 0, Math.PI * 2);
                    cursorCtx.strokeStyle = currentTool === 'eraser' ? 'rgba(255, 0, 0, 0.8)' : 'rgba(0, 170, 255, 0.8)';
                    cursorCtx.lineWidth = 2;
                    cursorCtx.stroke();
                    
                    // Add fill
                    cursorCtx.fillStyle = currentTool === 'eraser' ? 'rgba(255, 0, 0, 0.2)' : 'rgba(0, 170, 255, 0.2)';
                    cursorCtx.fill();
                    
                    // Add text label showing brush size
                    cursorCtx.font = 'bold 14px sans-serif';
                    cursorCtx.fillStyle = 'white';
                    cursorCtx.textAlign = 'center';
                    cursorCtx.textBaseline = 'bottom';
                    cursorCtx.fillText(`Size: ${brushSize}`, canvasX, canvasY - scaledBrushSize/2 - 10);
                }
            };
            
            // Add event listener for brush size changes
            brushSizeInput.addEventListener('input', function(e) {
                brushSize = parseInt(e.target.value) || 5;
                console.log('Brush size changed to:', brushSize);
                
                if (brushSizeLabel) {
                    brushSizeLabel.textContent = `${brushSize}px`;
                }
                
                // Show brush preview while adjusting slider
                window.showBrushPreview = true;
                
                // Show preview in center of canvas
                showBrushPreviewInCenter();
                
                // If mouse is over canvas, also update at mouse position
                if (mouseX !== null && mouseY !== null && maskCanvas) {
                    // Get a reference to the current canvas rect
                    const canvasRect = maskCanvas.getBoundingClientRect();
                    
                    // Check if mouse is over canvas
                    if (
                        mouseX >= canvasRect.left && 
                        mouseX <= canvasRect.right && 
                        mouseY >= canvasRect.top && 
                        mouseY <= canvasRect.bottom
                    ) {
                        // Create a simulated mouse event to update the cursor
                        const mockEvent = {
                            clientX: mouseX,
                            clientY: mouseY
                        };
                        updateCursor(mockEvent);
                    }
                }
            });
            
            // Add event listeners to hide brush preview when slider interaction ends
            brushSizeInput.addEventListener('change', function() {
                // Hide brush preview when slider is released
                window.showBrushPreview = false;
                
                if (cursorCanvas && cursorCtx) {
                    cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
                }
                
                // Update cursor if mouse is over canvas
                if (mouseX !== null && mouseY !== null && maskCanvas) {
                    const canvasRect = maskCanvas.getBoundingClientRect();
                    if (
                        mouseX >= canvasRect.left && 
                        mouseX <= canvasRect.right && 
                        mouseY >= canvasRect.top && 
                        mouseY <= canvasRect.bottom
                    ) {
                        const mockEvent = {
                            clientX: mouseX,
                            clientY: mouseY
                        };
                        updateCursor(mockEvent);
                    }
                }
            });
            
            // Additional event listener for when mouse leaves the slider
            brushSizeInput.addEventListener('mouseup', function() {
                setTimeout(() => {
                    window.showBrushPreview = false;
                    
                    if (cursorCanvas && cursorCtx) {
                        cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
                    }
                    
                    // Update cursor if mouse is over canvas
                    if (mouseX !== null && mouseY !== null && maskCanvas) {
                        const canvasRect = maskCanvas.getBoundingClientRect();
                        if (
                            mouseX >= canvasRect.left && 
                            mouseX <= canvasRect.right && 
                            mouseY >= canvasRect.top && 
                            mouseY <= canvasRect.bottom
                        ) {
                            const mockEvent = {
                                clientX: mouseX,
                                clientY: mouseY
                            };
                            updateCursor(mockEvent);
                        }
                    }
                }, 100); // Small delay to ensure it happens after other events
            });
        }
        
        // Initialize tool buttons
        if (brushBtn) {
            brushBtn.addEventListener('click', function() {
                currentTool = 'brush';
                isEraser = false;
                console.log('Tool set to brush');
                brushBtn.classList.add('active');
                if (eraserBtn) eraserBtn.classList.remove('active');
                
                // Update cursor appearance
                if (mouseX !== null && mouseY !== null) {
                    const mockEvent = {
                        clientX: mouseX,
                        clientY: mouseY
                    };
                    updateCursor(mockEvent);
            }
        });
    }

        if (eraserBtn) {
            eraserBtn.addEventListener('click', function() {
                currentTool = 'eraser';
                isEraser = true;
                console.log('Tool set to eraser');
                eraserBtn.classList.add('active');
                if (brushBtn) brushBtn.classList.remove('active');
                
                // Update cursor appearance
                if (mouseX !== null && mouseY !== null) {
                    const mockEvent = {
                        clientX: mouseX,
                        clientY: mouseY
                    };
                    updateCursor(mockEvent);
            }
        });
    }

        if (clearBtn) {
            clearBtn.addEventListener('click', function() {
                if (maskCtx && maskCanvas) {
                    console.log('Clearing mask canvas');
                    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
                }
            });
        }
        
        console.log('Brush tools initialized');
        } catch (error) {
        console.error('Error initializing brush tools:', error);
    }
}

// Function to load brush cursor image
async function loadBrushCursorImage() {
    try {
        console.log('Loading brush cursor image');
        
        // Try to load external image
        try {
            brushCursorImage = new Image();
            
            // Use a promise to wait for the image to load with a timeout
            await Promise.race([
                new Promise((resolve, reject) => {
                    brushCursorImage.onload = () => {
                        console.log('Brush cursor image loaded successfully with dimensions:', 
                                    brushCursorImage.width, 'x', brushCursorImage.height);
                        resolve();
                    };
                    brushCursorImage.onerror = (err) => {
                        console.error('Failed to load brush cursor image:', err);
                        reject(new Error(`Failed to load brush cursor image: ${err.message || 'Unknown error'}`));
                    };
                    
                    // Use the correct filename with double .png.png extension
                    brushCursorImage.src = 'assets/images/brush-cursor.png';
                    console.log('Attempting to load brush cursor from:', brushCursorImage.src);
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout loading image')), 5000))
            ]);
            
            // Now load the eraser cursor image
            eraserCursorImage = new Image();
            await Promise.race([
                new Promise((resolve, reject) => {
                    eraserCursorImage.onload = () => {
                        console.log('Eraser cursor image loaded successfully with dimensions:', 
                                   eraserCursorImage.width, 'x', eraserCursorImage.height);
                        resolve();
                    };
                    eraserCursorImage.onerror = (err) => {
                        console.error('Failed to load eraser cursor image:', err);
                        reject(new Error(`Failed to load eraser cursor image: ${err.message || 'Unknown error'}`));
                    };
                    
                    // Use eraser cursor image
                    eraserCursorImage.src = 'assets/images/eraser-cursor.png';
                    console.log('Attempting to load eraser cursor from:', eraserCursorImage.src);
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout loading image')), 5000))
            ]);
            
            return {brush: brushCursorImage, eraser: eraserCursorImage};
        } catch (imageError) {
            console.warn('Could not load cursor images:', imageError);
            console.log('Creating fallback cursor images');
            
            // Create a simple brush cursor image using canvas
            const brushCanvas = document.createElement('canvas');
            brushCanvas.width = 64;
            brushCanvas.height = 64;
            const brushCtx = brushCanvas.getContext('2d');
            
            // Draw a simple brush cursor
            brushCtx.fillStyle = 'rgba(0, 170, 255, 0.5)';
            brushCtx.beginPath();
            brushCtx.arc(32, 32, 20, 0, Math.PI * 2);
            brushCtx.fill();
            
            brushCtx.strokeStyle = 'rgba(0, 170, 255, 0.8)';
            brushCtx.lineWidth = 2;
            brushCtx.beginPath();
            brushCtx.arc(32, 32, 20, 0, Math.PI * 2);
            brushCtx.stroke();
            
            // Convert canvas to image
            brushCursorImage = new Image();
            brushCursorImage.src = brushCanvas.toDataURL();
            
            // Create a simple eraser cursor image using canvas
            const eraserCanvas = document.createElement('canvas');
            eraserCanvas.width = 64;
            eraserCanvas.height = 64;
            const eraserCtx = eraserCanvas.getContext('2d');
            
            // Draw a simple eraser cursor
            eraserCtx.fillStyle = 'rgba(255, 0, 0, 0.5)';
            eraserCtx.beginPath();
            eraserCtx.arc(32, 32, 20, 0, Math.PI * 2);
            eraserCtx.fill();
            
            eraserCtx.strokeStyle = 'rgba(255, 0, 0, 0.8)';
            eraserCtx.lineWidth = 2;
            eraserCtx.beginPath();
            eraserCtx.arc(32, 32, 20, 0, Math.PI * 2);
            eraserCtx.stroke();
            
            // Convert canvas to image
            eraserCursorImage = new Image();
            eraserCursorImage.src = eraserCanvas.toDataURL();
            
            // Wait for both to load
            await Promise.all([
                new Promise(resolve => { brushCursorImage.onload = resolve; }),
                new Promise(resolve => { eraserCursorImage.onload = resolve; })
            ]);
            
            console.log('Created fallback cursor images');
            return {brush: brushCursorImage, eraser: eraserCursorImage};
        }
    } catch (error) {
        console.error('Error in cursor image creation:', error);
        // Use null as fallback
        brushCursorImage = null;
        eraserCursorImage = null;
        return {brush: null, eraser: null};
    }
}

// Function to update prompt text areas based on slider contributions
function updatePromptsFromSliders() {
    try {
        console.log('Updating prompts from sliders');
        
        // Get the prompt text areas
        const mainSubjectPrompt = document.getElementById('main-subject-prompt');
        const contextPrompt = document.getElementById('context-prompt');
        const avoidPrompt = document.getElementById('avoid-prompt');
        
        if (!mainSubjectPrompt || !contextPrompt || !avoidPrompt) {
            console.warn('Prompt text areas not found');
            return;
        }
        
        // Get pure user text (without any slider contributions)
        const userMainText = mainSubjectPrompt.dataset.userText || '';
        const userContextText = contextPrompt.dataset.userText || '';
        
        // Collect active contributions (only non-empty ones)
        const mainContributions = [];
        const contextContributions = [];
        
        Object.entries(sliderContributions).forEach(([key, contribution]) => {
            if (!contribution || (!contribution.main && !contribution.context)) {
                console.log(`Skipping empty contribution for ${key}`);
                return;
            }
        
            console.log(`Adding contribution for ${key}:`, contribution);
            
            if (contribution.main) {
                mainContributions.push(contribution.main);
            }
            if (contribution.context) {
                contextContributions.push(contribution.context);
            }
        });
        
        // Build final text with comma separation
        let finalMainText = userMainText;
        let finalContextText = userContextText;
        
        // Add main contributions with comma separation
        if (mainContributions.length > 0) {
            if (finalMainText && finalMainText.trim()) {
                finalMainText += ', ' + mainContributions.join(', ');
            } else {
                finalMainText = mainContributions.join(', ');
            }
        }
        
        // Add context contributions with comma separation
        if (contextContributions.length > 0) {
            if (finalContextText && finalContextText.trim()) {
                finalContextText += ', ' + contextContributions.join(', ');
            } else {
                finalContextText = contextContributions.join(', ');
            }
        }
        
        // Update the text areas with the final text
        if (finalMainText.trim() === '' && !userMainText) {
            // Only use example text if there's no user text and no contributions
            if (mainSubjectPrompt.dataset.example) {
                mainSubjectPrompt.value = mainSubjectPrompt.dataset.example;
                console.log('Using example text for main subject:', mainSubjectPrompt.dataset.example);
            }
        } else {
            mainSubjectPrompt.value = finalMainText;
        }
        
        if (finalContextText.trim() === '' && !userContextText) {
            // Only use example text if there's no user text and no contributions
            if (contextPrompt.dataset.example) {
                contextPrompt.value = contextPrompt.dataset.example;
                console.log('Using example text for context:', contextPrompt.dataset.example);
            }
        } else {
            contextPrompt.value = finalContextText;
        }
        
        console.log('Prompts updated to:', {
            main: mainSubjectPrompt.value,
            context: contextPrompt.value
        });
    } catch (error) {
        console.error('Error updating prompts from sliders:', error);
    }
}

// Function to initialize sliders
function initializeSliders() {
    try {
        console.log('Initializing sliders');
        
        const sliders = {
            'lighting': document.getElementById('lighting'),
            'layout': document.getElementById('layout'),
            'community': document.getElementById('community'),
            'functionality': document.getElementById('functionality'),
            'visual-elements': document.getElementById('visual-elements')
        };
        
        // Slider text values for different positions
        const sliderTexts = {
            'lighting': {
                0: { main: '', context: '' },
                25: { main: 'with controlled artificial lighting', context: 'the space has warm, adjustable artificial lighting with curtains for light control' },
                50: { main: 'with balanced natural light', context: 'the space has good natural lighting with curtains to control intensity' },
                75: { main: 'with abundant natural light', context: 'the space has large windows with adjustable blinds for light control' },
                100: { main: 'with maximum natural light', context: 'the space is flooded with natural light through large windows with smart light control systems' }
            },
            'layout': {
                0: { main: '', context: '' },
                25: { main: 'with basic personal space', context: 'the space has individual desk areas with minimal crowding' },
                50: { main: 'with organized zones', context: 'the space has well-defined areas for different activities' },
                75: { main: 'with spacious layout', context: 'the space has ample room between areas and good traffic flow' },
                100: { main: 'with optimal spatial organization', context: 'the space has perfect balance of personal and shared spaces with no cramping' }
            },
            'community': {
                0: { main: '', context: '' },
                25: { main: 'with basic interaction spaces', context: 'the space has some areas for casual social interaction' },
                50: { main: 'with collaborative areas', context: 'the space has dedicated zones for teamwork and discussion' },
                75: { main: 'with strong community focus', context: 'the space has round tables and multiple areas designed for conversation' },
                100: { main: 'with maximum social engagement', context: 'the space is optimized for collaboration with diverse meeting spaces and community areas' }
            },
            'functionality': {
                0: { main: '', context: '' },
                25: { main: 'with basic equipment', context: 'the space has essential tools and basic storage' },
                50: { main: 'with good functionality', context: 'the space has adequate storage and display options' },
                75: { main: 'with enhanced functionality', context: 'the space has design boards and improved storage solutions' },
                100: { main: 'with maximum functionality', context: 'the space has comprehensive equipment, storage, and amenities' }
            },
            'visual-elements': {
                0: { main: '', context: '' },
                25: { main: 'with basic aesthetics', context: 'the space has some artwork and views' },
                50: { main: 'with balanced aesthetics', context: 'the space has good artwork and views with some color' },
                75: { main: 'with enhanced aesthetics', context: 'the space has natural materials and reduced visual clutter' },
                100: { main: 'with maximum aesthetics', context: 'the space has natural materials, color, and minimal visual clutter' }
            }
        };
        
        // Initialize all sliders
        Object.entries(sliders).forEach(([id, slider]) => {
            if (slider) {
                // Set initial value
                slider.value = 0; // Force initial value to 0
                const valueDisplay = slider.nextElementSibling;
                if (valueDisplay) {
                    valueDisplay.textContent = '0%';
                }
                
                // Add event listener
                slider.addEventListener('input', function(e) {
                    const value = parseInt(e.target.value) || 0;
                    const valueDisplay = e.target.nextElementSibling;
                    if (valueDisplay) {
                        valueDisplay.textContent = `${value}%`;
                    }
                    
                    // Update slider contributions based on value
                    if (value === 0) {
                        sliderContributions[id] = { main: '', context: '' };
                        console.log(`Slider ${id} set to 0%, clearing contributions`);
                    } else {
                        // For non-zero values, find the appropriate threshold
                        const brackets = Object.keys(sliderTexts[id]).map(Number).sort((a, b) => a - b);
                        
                        // Find which bracket we're in
                        let lowerBracket = 0;
                        for (const bracket of brackets) {
                            if (value >= bracket) {
                                lowerBracket = bracket;
                            } else {
                                break;
                            }
                        }
                        
                        // For any non-zero value, use the next bracket up (avoid empty text at 0)
                        if (lowerBracket === 0 && value > 0) {
                            const firstNonZeroBracket = brackets.find(b => b > 0);
                            lowerBracket = firstNonZeroBracket;
                            console.log(`Using text from bracket ${lowerBracket} for value ${value}`);
                        }
                        
                        sliderContributions[id] = sliderTexts[id][lowerBracket];
                    }
                    
                    console.log(`Slider ${id} set to ${value}%, contribution:`, JSON.stringify(sliderContributions[id]));
                    
                    // Update prompts
                    updatePromptsFromSliders();
                });
                
                // Trigger the input event to set initial slider contributions
                slider.dispatchEvent(new Event('input'));
            } else {
                console.warn(`Slider ${id} not found in the DOM`);
            }
        });
        
        console.log('Sliders initialized successfully');
    } catch (error) {
        console.error('Error initializing sliders:', error);
    }
}

// Get scaled coordinates for proper drawing
function getScaledCoordinates(e, canvas) {
    try {
        if (!canvas) return { x: 0, y: 0 };
        
        // Get the dimensions
        const rect = canvas.getBoundingClientRect();
        const displayWidth = rect.width;
        const displayHeight = rect.height;
        const actualWidth = canvas.width;
        const actualHeight = canvas.height;
        
        // Calculate the scaling factors
        const scaleX = actualWidth / displayWidth;
        const scaleY = actualHeight / displayHeight;
        
        // Calculate the scaled coordinates
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        
        return { x, y };
    } catch (error) {
        console.error('Error calculating scaled coordinates:', error);
        return { x: 0, y: 0 };
    }
}

// Update startDrawing function to use different scaling factor based on image source
function startDrawing(e) {
    try {
        isDrawing = true;
        
        // Emit start drawing event
        if (socket && socket.connected) {
            socket.emit('start_drawing');
        }
        
        // Get properly scaled coordinates
        const coords = getScaledCoordinates(e, maskCanvas);
        const x = coords.x;
        const y = coords.y;
        
        // Store for cursor calculations
        mouseX = e.clientX;
        mouseY = e.clientY;
        
        // Store position
        lastX = x;
        lastY = y;
        
        // Use requestAnimationFrame for smoother drawing
        requestAnimationFrame(() => {
            // Calculate scaled brush size based on image dimensions
            let scaledBrushSize = brushSize;
            
            // Apply the brush size factor (1-10 scale to pixels)
            const brushSizeFactor = 10;
            scaledBrushSize = scaledBrushSize * brushSizeFactor;
            
            if (originalImage && maskCanvas) {
                const canvasAspect = maskCanvas.width / maskCanvas.height;
                const imageAspect = originalImage.width / originalImage.height;
                
                // Scale the brush size based on image-to-canvas ratio
                if (imageAspect > canvasAspect) {
                    // Image is constrained by width
                    const scale = maskCanvas.width / originalImage.width;
                    // Apply different scaling factors based on image source
                    if (imageLoadedFromModal) {
                        scaledBrushSize = scaledBrushSize * scale * 3; // Triple for modal images
                    } else {
                        scaledBrushSize = scaledBrushSize * scale * 2; // Double for street view
                    }
                } else {
                    // Image is constrained by height
                    const scale = maskCanvas.height / originalImage.height;
                    // Apply different scaling factors based on image source
                    if (imageLoadedFromModal) {
                        scaledBrushSize = scaledBrushSize * scale * 3; // Triple for modal images
                    } else {
                        scaledBrushSize = scaledBrushSize * scale * 2; // Double for street view
                    }
                }
            }
            
            // Draw a dot at the click position
            maskCtx.beginPath();
            maskCtx.arc(x, y, scaledBrushSize/2, 0, Math.PI * 2);
            
            if (currentTool === 'eraser') {
                maskCtx.globalCompositeOperation = 'destination-out';
                maskCtx.fillStyle = 'rgba(0, 0, 0, 1)';
            } else {
                maskCtx.globalCompositeOperation = 'source-over';
                
                // Use full color with fixed alpha to avoid transparency buildup
                const fixedAlpha = 0.1; // Fixed 10% transparency
                let brushColor;
                
                if (userColor) {
                    // Convert hex color to RGB with fixed alpha
                    const r = parseInt(userColor.slice(1, 3), 16);
                    const g = parseInt(userColor.slice(3, 5), 16);
                    const b = parseInt(userColor.slice(5, 7), 16);
                    brushColor = `rgba(${r}, ${g}, ${b}, ${fixedAlpha})`;
                } else {
                    brushColor = 'rgba(255, 0, 0, 0.1)'; // Default red with fixed alpha
                }
                
                maskCtx.fillStyle = brushColor;
            }
            
            maskCtx.fill();
            maskCtx.globalCompositeOperation = 'source-over';
            
            // Update cursor to show drawing state
            updateCursor(e);
            
            console.log('Started drawing at:', x, y, 'with brush size:', scaledBrushSize);
        });
    } catch (error) {
        console.error('Error in startDrawing:', error);
    }
}

// Stop drawing
function stopDrawing() {
    isDrawing = false;
    
    // Emit stop drawing event
    if (socket && socket.connected) {
        socket.emit('stop_drawing');
    }
}

// Update cursor position
function updateCursor(e) {
    if (!cursorCanvas || !cursorCtx || !maskCanvas) {
            return;
        }

    // Get coordinates relative to the canvas
    const rect = maskCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Store for other functions to use
    mouseX = e.clientX;
    mouseY = e.clientY;
    
    // Also update last position for drawing
    // (only when not actively drawing to avoid jumps)
    if (!isDrawing) {
        const coords = getScaledCoordinates(e, maskCanvas);
        lastX = coords.x;
        lastY = coords.y;
    }

    // Only show cursor when inside the canvas
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
        cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
        return;
    }
    
    // Clear previous cursor
    cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
    
    // IMPROVED: Use the precise scaled coordinates instead of recalculating
    const coords = getScaledCoordinates(e, maskCanvas);
    const canvasX = coords.x;
    const canvasY = coords.y;
    
    // Draw brush preview circle only if slider is being adjusted (controlled by showBrushPreview flag)
    if (window.showBrushPreview) {
        // Get current brush size (scaled to canvas dimensions)
        let scaledBrushSize = brushSize;
        
        // Since our brush size is now 1-10, we'll multiply it by a factor to make it more visible
        const brushSizeFactor = 10; // Each unit of brush size represents 10 pixels
        scaledBrushSize = scaledBrushSize * brushSizeFactor;
        
        // Calculate scale factor based on canvas vs original image size
        if (currentImage && maskCanvas) {
            const canvasAspect = maskCanvas.width / maskCanvas.height;
            const imageAspect = currentImage.width / currentImage.height;
            
            // Adjust brush size based on how the image is fitted to the canvas
            if (imageAspect > canvasAspect) {
                // Image is constrained by width
                const scale = maskCanvas.width / currentImage.width;
                // Apply different scaling factors based on image source
                if (imageLoadedFromModal) {
                    scaledBrushSize = scaledBrushSize * scale * 3; // Triple for modal images
                } else {
                    scaledBrushSize = scaledBrushSize * scale * 2; // Double for street view
                }
            } else {
                // Image is constrained by height
                const scale = maskCanvas.height / currentImage.height;
                // Apply different scaling factors based on image source
                if (imageLoadedFromModal) {
                    scaledBrushSize = scaledBrushSize * scale * 3; // Triple for modal images
                } else {
                    scaledBrushSize = scaledBrushSize * scale * 2; // Double for street view
                }
            }
        }
        
        // Draw the circle preview for brush size
        cursorCtx.beginPath();
        cursorCtx.arc(canvasX, canvasY, scaledBrushSize/2, 0, Math.PI * 2);
        cursorCtx.strokeStyle = currentTool === 'eraser' ? 'rgba(255, 0, 0, 0.8)' : 'rgba(0, 170, 255, 0.8)';
        cursorCtx.lineWidth = 2;
        cursorCtx.stroke();
        
        // Optional: Add a fill to make it more visible
        cursorCtx.fillStyle = currentTool === 'eraser' ? 'rgba(255, 0, 0, 0.2)' : 'rgba(0, 170, 255, 0.2)';
        cursorCtx.fill();
    }
    
    // Always draw the appropriate cursor image based on the current tool
    const cursorImage = currentTool === 'eraser' ? eraserCursorImage : brushCursorImage;
    if (cursorImage) {
        // Use a larger fixed size for the cursor image
        const cursorImageSize = 35; // Increased from 20 to 35
        // IMPROVED: Draw at the precise scaled coordinates to ensure alignment
        cursorCtx.drawImage(
            cursorImage,
            canvasX - cursorImageSize/2,
            canvasY - cursorImageSize/2,
            cursorImageSize,
            cursorImageSize
        );
    }
}

// Handle mouse enter
function handleMouseEnter(e) {
    // Make sure we have mouse position for cursor updates
    mouseX = e.clientX;
    mouseY = e.clientY;
    
    // Update cursor when mouse enters canvas
    updateCursor(e);
    
    console.log('Mouse entered canvas');
}

// Handle mouse leave
function handleMouseLeave(e) {
    // Clear cursor canvas when mouse leaves
    if (cursorCanvas && cursorCtx) {
        cursorCtx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
    }
    
    // Stop drawing if mouse leaves canvas
    if (isDrawing) {
        stopDrawing();
    }
    
    // Reset mouse position tracking
    mouseX = null;
    mouseY = null;
    
    console.log('Mouse left canvas');
}

// Add loadStreetViewImage function to fetch and display Street View images
async function loadStreetViewImage(position, panoramaId = null, heading = null) {
    try {
        if (!position) {
            console.error('No position provided to loadStreetViewImage');
            return;
        }
        
        console.log('Loading Street View image for position:', position);
        
        // Set flag to false as we're loading from Street View
        imageLoadedFromModal = false;
        console.log('Set imageLoadedFromModal to false');
        
        // Make sure we have the Street View service
        if (!streetViewService) {
            streetViewService = new google.maps.StreetViewService();
        }
        
        // Store current submission location
        currentSubmissionLocation = {
            lat: typeof position.lat === 'function' ? position.lat() : position.lat,
            lng: typeof position.lng === 'function' ? position.lng() : position.lng
        };
        
        // Create a Street View location object
        const location = new google.maps.LatLng(
            currentSubmissionLocation.lat,
            currentSubmissionLocation.lng
        );
        
        let panoramaData;
        if (panoramaId) {
            // If panoramaId is provided, use it directly
            panoramaData = {
                location: {
                    pano: panoramaId,
                    latLng: location
                }
            };
        } else {
            // Otherwise request the panorama
            panoramaData = await new Promise((resolve, reject) => {
                streetViewService.getPanorama(
                    { location: location, radius: 50, source: 'outdoor' },
                    (data, status) => {
                        if (status === google.maps.StreetViewStatus.OK) {
                            resolve(data);
                        } else {
                            reject(new Error(`Street View data not found for this location. Status: ${status}`));
                        }
                    }
                );
            });
        }
        
        // Store panorama ID for sharing between clients
        const finalPanoramaId = panoramaId || panoramaData.location.pano;
        console.log('Using panorama ID:', finalPanoramaId);
        
        // Calculate heading if not provided
        const finalHeading = heading !== null ? heading : google.maps.geometry.spherical.computeHeading(
            panoramaData.location.latLng, 
            location
        );
        
        // Construct the Street View image URL
        const width = 640;
        const height = 480;
        const fov = 90;
        const pitch = 0;
        
        // Use panorama ID to ensure consistent view across clients
        const streetViewUrl = `https://maps.googleapis.com/maps/api/streetview?size=${width}x${height}&pano=${finalPanoramaId}&heading=${finalHeading}&pitch=${pitch}&fov=${fov}&key=${config.googleMapsApiKey}`;
        
        console.log('Street View image URL:', streetViewUrl);
        
        // Load the image
        const img = new Image();
        img.crossOrigin = "anonymous";
        
        await new Promise((resolve, reject) => {
            img.onload = () => {
                console.log('Street View image loaded successfully:', img.width, 'x', img.height);
                resolve();
            };
            img.onerror = (error) => {
                console.error('Error loading Street View image:', error);
                reject(new Error(`Failed to load Street View image: ${error.message || 'Unknown error'}`));
            };
            img.src = streetViewUrl;
        });
        
        // Initialize the drawing canvas with the loaded image
        await initializeDrawingCanvas(img);
        
        // Emit image_upload event first with all Street View data
        if (socket && socket.connected) {
            console.log('Emitting image_upload with Street View data');
            socket.emit('image_upload', {
                imageUrl: streetViewUrl,
                user_id: socket.id,
                is_street_view: true,
                location: currentSubmissionLocation,
                panorama_id: finalPanoramaId,
                heading: finalHeading
            });
            
            // Then emit location_updated event
            console.log('Emitting location update with panorama data');
            socket.emit('location_updated', {
                location: currentSubmissionLocation,
                panorama_id: finalPanoramaId,
                heading: finalHeading,
                image_url: streetViewUrl
            });
        }
        
        return streetViewUrl;
    } catch (error) {
        console.error('Error loading Street View image:', error);
        alert('Could not load Street View for this location. Please try another location.');
        return null;
    }
}

// Make loadStreetViewImage available globally
window.loadStreetViewImage = loadStreetViewImage;

// Update the initMap function override to ensure map click events work
window.origInitMap = window.initMap; // Store the original initMap function
window.initMap = function() {
    // Call the original initMap function
    window.origInitMap();
    
    // After map is initialized, add click events
    if (window.map) {
        console.log('Map is available, adding click handler immediately');
        initializeMapClickEvents();
    } else {
        // If map isn't ready yet, wait a bit and try again
        console.log('Map not available yet, will retry adding click handler in 1 second');
        setTimeout(() => {
            if (window.map) {
                console.log('Map is now available, adding click handler');
                initializeMapClickEvents();
            } else {
                console.log('Map still not available, will add handler when Street View is shown');
                // Add an event listener to the Street View button to ensure map is initialized
                const loadStreetViewBtn = document.getElementById('loadStreetViewBtn');
                if (loadStreetViewBtn) {
                    loadStreetViewBtn.addEventListener('click', function() {
                        setTimeout(() => {
                            if (window.map) {
                                console.log('Map is now available after Street View section was shown');
                                initializeMapClickEvents();
                            }
                        }, 1000);
                    });
                }
            }
        }, 1000);
    }
};

// Improved function to initialize map click events
function initializeMapClickEvents() {
    if (!window.map) {
        console.error('Cannot initialize map click events: map not available');
        return;
    }

    console.log('Setting up map click handler on map:', window.map);
    
    // Remove any existing click listeners to avoid duplicates
    google.maps.event.clearListeners(window.map, 'click');
    
    // Add click listener to allow placing pins directly on the map
    window.map.addListener('click', function(event) {
        const clickedLocation = event.latLng;
        console.log('Map clicked at location:', clickedLocation.lat(), clickedLocation.lng());
        
        // Update Street View for the clicked location
        if (window.updateStreetView) {
            window.updateStreetView(clickedLocation);
        }
    });
    
    console.log('Map click handler installed successfully');
}

// Function to generate image based on current mask and prompts
async function generateImage() {
    try {
        console.log('Generating image...');
        
        // Check if we have an image to work with
        if (!imageCanvas || !maskCanvas || !currentImage) {
            alert('Please load an image first');
            return;
        }
        
        // Get the prompt text values
        const mainSubjectPrompt = document.getElementById('main-subject-prompt').value;
        const contextPrompt = document.getElementById('context-prompt').value;
        const avoidPrompt = document.getElementById('avoid-prompt').value;
        
        // Create a combined prompt
        let prompt = mainSubjectPrompt;
        if (contextPrompt) {
            prompt += ', ' + contextPrompt;
        }
        
        // Show loading state
        const generateBtn = document.getElementById('generate-button');
        const originalBtnText = generateBtn.innerHTML;
        generateBtn.innerHTML = '<span class="generate-icon">⏳</span> Generating...';
        generateBtn.disabled = true;
        
        const previewContainer = document.getElementById('preview-container');
        if (previewContainer) {
            previewContainer.innerHTML = '<div class="loading">Generating image...</div>';
        }
        
        try {
            // First, check if ComfyUI is running
            try {
                const testResponse = await fetch('/test_comfyui', { method: 'GET' });
                const testResult = await testResponse.json();
                
                if (testResult.status !== 'success') {
                    throw new Error("ComfyUI is not running or not accessible. Please make sure ComfyUI is running on http://127.0.0.1:8188");
                }
            } catch (comfyError) {
                console.error('ComfyUI check failed:', comfyError);
                if (previewContainer) {
                    previewContainer.innerHTML = `<div class="error" style="color: #ff5555; padding: 20px; text-align: center; background-color: rgba(255,0,0,0.1); border-radius: 8px;">
                        <h3 style="margin-top: 0;">ComfyUI Not Available</h3>
                        <p>The image generation service (ComfyUI) is not running or not accessible.</p>
                        <p>Please make sure ComfyUI is running on <code>http://127.0.0.1:8188</code></p>
                    </div>`;
                }
                
                // Reset button state
                if (generateBtn) {
                    generateBtn.innerHTML = originalBtnText;
                    generateBtn.disabled = false;
                }
                
                return; // Stop execution
            }
            
            // Get image and mask data
            const imageData = imageCanvas.toDataURL('image/png');
            const maskData = maskCanvas.toDataURL('image/png');
            
            // Convert base64 data URLs to base64 strings (remove the header)
            const imageBase64 = imageData.split(',')[1];
            const maskBase64 = maskData.split(',')[1];
            
            // Prepare data for the API
            const requestData = {
                image: imageBase64,
                mask: maskBase64,
                prompt: prompt,
                negative_prompt: avoidPrompt
            };
            
            console.log('Sending generation request to API...');
            
            // Send the request to the server
            const response = await fetch('/api/process', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestData)
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`API error: ${response.status} ${response.statusText}`, errorText);
                
                // Check if this is likely a ComfyUI connection error
                if (errorText.includes("Failed to communicate with ComfyUI") || 
                    errorText.includes("Connection refused") ||
                    errorText.includes("No checkpoint models found")) {
                    throw new Error("ComfyUI is not running or not accessible. Please make sure ComfyUI is running on http://127.0.0.1:8188");
                } else {
                    throw new Error(`API error: ${response.status} ${response.statusText}`);
                }
            }
            
            const result = await response.json();
            
            if (result.error) {
                throw new Error(result.error);
            }
            
            if (result.image_url) {
                console.log('Image generated successfully:', result.image_url);
                
                // Use the proxy-image route to avoid CORS issues
                const proxiedImageUrl = `/proxy-image?url=${encodeURIComponent(result.image_url)}`;
                
                // Display the generated image
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = function() {
                    if (previewContainer) {
                        previewContainer.innerHTML = '';
                        previewContainer.appendChild(img);
                    }
                    
                    // Store the original URL for potential submission
                    generatedImageUrl = result.image_url;
                    
                    // Enable the submit button if it exists
                    const submitBtn = document.getElementById('submit-to-map-btn');
                    if (submitBtn) {
                        submitBtn.disabled = false;
                    }
                    
                    // Emit the generated image to other users with all necessary data
                    if (socket && socket.connected) {
                        socket.emit('image_generated', {
                            image_url: result.image_url,
                            prompt: prompt,
                            negative_prompt: avoidPrompt,
                            user_id: socket.id,
                            timestamp: new Date().toISOString()
                        });
                    }
                };
                
                img.onerror = function(e) {
                    console.error('Error loading image:', e);
                    if (previewContainer) {
                        previewContainer.innerHTML = '<div class="error">Error loading generated image</div>';
                    }
                };
                
                // Use the proxied URL for the image source
                img.src = proxiedImageUrl;
                img.style.maxWidth = '100%';
                img.style.maxHeight = '100%';
                
            } else if (result.image) {
                console.log('Image generated successfully (base64)');
                
                // Display the generated image (base64 format)
                const img = new Image();
                img.onload = function() {
                    if (previewContainer) {
                        previewContainer.innerHTML = '';
                        previewContainer.appendChild(img);
                    }
                    
                    // No URL to store for submission in this case
                    // Display a notification that sharing won't be possible
                    if (result.firebase_error) {
                        console.warn('Firebase storage error:', result.firebase_error);
                        const notification = document.createElement('div');
                        notification.className = 'warning';
                        notification.style.color = '#856404';
                        notification.style.backgroundColor = '#fff3cd';
                        notification.style.padding = '10px';
                        notification.style.borderRadius = '4px';
                        notification.style.marginTop = '10px';
                        notification.style.fontSize = '12px';
                        notification.innerHTML = 'Note: Image sharing is not available due to a storage service error.';
                        previewContainer.appendChild(notification);
                        
                        // Disable the submit button since we can't share
                        const submitBtn = document.getElementById('submit-to-map-btn');
                        if (submitBtn) {
                            submitBtn.disabled = true;
                            submitBtn.title = 'Sharing unavailable due to storage service error';
                        }
                    }
                };
                
                img.src = 'data:image/png;base64,' + result.image;
                img.style.maxWidth = '100%';
                img.style.maxHeight = '100%';
                
            } else {
                throw new Error('No image received in the response');
            }
            
        } catch (apiError) {
            console.error('Error calling API:', apiError);
            
            // Show error in preview container
            if (previewContainer) {
                let errorMessage = apiError.message;
                let isComfyUIError = errorMessage.includes('ComfyUI');
                
                previewContainer.innerHTML = `<div class="error" style="color: #ff5555; padding: 20px; text-align: center; background-color: rgba(255,0,0,0.1); border-radius: 8px;">
                    <h3 style="margin-top: 0;">${isComfyUIError ? 'ComfyUI Error' : 'Generation Error'}</h3>
                    <p>${errorMessage}</p>
                    ${isComfyUIError ? '<p>Please check that ComfyUI is running correctly.</p>' : ''}
                </div>`;
            }
            
            // Avoid showing alert if the error is already displayed
            if (!apiError.message.includes('ComfyUI')) {
                alert(`Failed to generate image: ${apiError.message}`);
            }
        } finally {
            // Reset button state
            if (generateBtn) {
                generateBtn.innerHTML = originalBtnText;
                generateBtn.disabled = false;
            }
        }
        
    } catch (error) {
        console.error('Error in generateImage:', error);
        alert(`An error occurred: ${error.message}`);
    }
}

// Function to add a submission marker to the map
function addSubmissionMarker(submission) {
    if (!submissionsMap || !submission.location) return;
    
    const position = new google.maps.LatLng(
        submission.location.lat,
        submission.location.lng
    );
    
            const marker = new google.maps.Marker({
                position: position,
                map: submissionsMap,
        title: submission.prompts ? submission.prompts.mainSubject : 'Submission'
    });
    
    // Add click event to show more details
    marker.addListener('click', () => {
        // Create an info window with submission details
        let content = `<div class="submission-info" style="color: white; padding: 10px; max-width: 250px;">`;
        
        if (submission.imageUrl) {
            // Use proxy route for image to avoid CORS issues
            const proxiedImageUrl = `/proxy-image?url=${encodeURIComponent(submission.imageUrl)}`;
            content += `<img src="${proxiedImageUrl}" style="max-width: 100%; max-height: 150px; border-radius: 4px; margin-bottom: 10px;" />`;
        }
        
        content += `<p style="margin: 5px 0;"><strong style="color: #2196F3;">Main: </strong>${submission.prompts?.mainSubject || 'N/A'}</p>`;
        content += `<p style="margin: 5px 0;"><strong style="color: #2196F3;">Context: </strong>${submission.prompts?.context || 'N/A'}</p>`;
        content += `</div>`;
        
        // Close previous info window if open
                if (currentInfoWindow) {
                    currentInfoWindow.close();
                }
        
        // Create and open new info window with custom styling
        currentInfoWindow = new google.maps.InfoWindow({
            content: content,
            maxWidth: 300,
            pixelOffset: new google.maps.Size(0, -5)
        });
        
        // Apply dark theme styling to the info window after it's opened
        google.maps.event.addListenerOnce(currentInfoWindow, 'domready', () => {
            try {
                // Get the infowindow container
                const iwOuter = document.querySelector('.gm-style-iw-a');
                if (iwOuter) {
                    // Style the info window container
                    iwOuter.nextElementSibling.style.display = 'none'; // Hide the default close button
                    
                    // Find the inner container and style it
                    const iwBackground = iwOuter.querySelector('.gm-style-iw-t');
                    if (iwBackground) {
                        iwBackground.style.backgroundColor = '#1a1a1a';
                        iwBackground.parentElement.style.backgroundColor = '#1a1a1a';
                    }
                    
                    // Find all the divs inside the info window and style them
                    const iwContainer = document.querySelector('.gm-style-iw');
                    if (iwContainer) {
                        iwContainer.style.backgroundColor = '#1a1a1a';
                        iwContainer.style.padding = '12px';
                        iwContainer.style.borderRadius = '8px';
                        iwContainer.style.border = '1px solid rgba(255, 255, 255, 0.1)';
                        iwContainer.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.5)';
                        
                        // Style the overflow container
                        const iwContent = iwContainer.querySelector('.gm-style-iw-d');
                        if (iwContent) {
                            iwContent.style.backgroundColor = '#1a1a1a';
                            iwContent.style.color = 'white';
                            iwContent.style.overflow = 'hidden';
                            iwContent.style.maxHeight = 'none !important';
                        }
                    }
                }
    } catch (error) {
                console.error('Error styling info window:', error);
            }
        });
        
        currentInfoWindow.open(submissionsMap, marker);
    });
    
    submissionsMarkers.push(marker);
}

// Function to handle submission to map
function handleSubmission() {
    try {
        console.log('Handling submission...');
        
        // Check if we have a generated image
        if (!generatedImageUrl) {
            alert('Please generate an image first before submitting');
            return;
        }

        // Get the prompt text values
        const mainSubjectPrompt = document.getElementById('main-subject-prompt').value;
        const contextPrompt = document.getElementById('context-prompt').value;
        
        // Determine location based on image source
        let submissionLocation;
        
        if (currentSubmissionLocation && !imageLoadedFromModal) {
            // Use the Street View location if available and using Street View
            submissionLocation = currentSubmissionLocation;
            console.log('Using Street View location for submission:', submissionLocation);
        } else {
            // Fall back to Columbia University coordinates for modal images
            submissionLocation = {
                lat: 40.8075,
                lng: -73.9626
            };
            console.log('Using Columbia University location for submission');
        }

        // Create submission object
        const submission = {
            imageUrl: generatedImageUrl,
            location: submissionLocation,
            prompts: {
                mainSubject: mainSubjectPrompt,
                context: contextPrompt
            },
            submittedAt: new Date().toISOString(),
            userId: userId || 'anonymous'
        };
        
        console.log('Created submission:', submission);
        
        // Send submission to server (if connected)
        if (socket && socket.connected) {
            socket.emit('submission', submission);
        }
        
        // Store submission locally
        const submissions = JSON.parse(localStorage.getItem('submissions') || '[]');
        submissions.push(submission);
        localStorage.setItem('submissions', JSON.stringify(submissions));
        
        // Show confirmation
        alert('Your design has been submitted to the map!');
        
        // Open the submissions modal to show the submission
        openSubmissionsModal();
        
        // Clear the generated image reference to prevent duplicate submissions
        generatedImageUrl = null;
        
        // Disable the submit button
        const submitBtn = document.getElementById('submit-to-map-btn');
        if (submitBtn) {
            submitBtn.disabled = true;
        }

    } catch (error) {
        console.error('Error handling submission:', error);
        alert('Error submitting your design. Please try again.');
    }
}

// Make handleSubmission globally available
window.handleSubmission = handleSubmission;

// Function to open the submissions modal with map display
function openSubmissionsModal() {
    try {
        console.log('Opening submissions modal');
        
        const modal = document.getElementById('submissionsModal');
        if (!modal) {
            console.error('Submissions modal not found');
            return;
        }
        
        // Add dark theme styling to the modal
        const modalContent = modal.querySelector('.submissions-modal-content');
        if (modalContent) {
            modalContent.style.backgroundColor = '#1a1a1a';
            modalContent.style.border = '1px solid rgba(255, 255, 255, 0.1)';
            modalContent.style.boxShadow = '0 4px 20px rgba(0, 0, 0, 0.5)';
            modalContent.style.borderRadius = '8px';
        }
        
        // Style the close button
        const closeButton = modal.querySelector('.close-map');
        if (closeButton) {
            closeButton.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
            closeButton.style.color = 'white';
            closeButton.style.border = '1px solid rgba(255, 255, 255, 0.2)';
        }
        
        // Remove existing button container if it exists
        let buttonContainer = modal.querySelector('.map-control-buttons');
        if (buttonContainer) {
            modalContent.removeChild(buttonContainer);
        }
        
        // Add a title to the map modal
        let mapTitle = modal.querySelector('.map-title');
        if (!mapTitle) {
            mapTitle = document.createElement('div');
            mapTitle.className = 'map-title';
            mapTitle.style.position = 'absolute';
            mapTitle.style.top = '10px';
            mapTitle.style.left = '50%';
            mapTitle.style.transform = 'translateX(-50%)';
            mapTitle.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
            mapTitle.style.color = 'white';
            mapTitle.style.padding = '8px 16px';
            mapTitle.style.borderRadius = '4px';
            mapTitle.style.fontSize = '16px';
            mapTitle.style.fontWeight = 'bold';
            mapTitle.style.zIndex = '1001';
            mapTitle.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.3)';
            mapTitle.style.border = '1px solid rgba(255, 255, 255, 0.2)';
            mapTitle.style.textAlign = 'center';
            mapTitle.innerHTML = 'Interactive Submissions Map<br><span style="font-size: 12px; font-weight: normal;">Click on clusters to see designs and analyze insights</span>';
            modalContent.appendChild(mapTitle);
        }
        
        // Display the modal - container must be visible before map initialization
        modal.style.display = 'block';
        
        // First cleanup any existing map
        if (submissionsMap) {
            console.log('Cleaning up existing map');
            google.maps.event.clearInstanceListeners(submissionsMap);
            submissionsMarkers.forEach(marker => marker.setMap(null));
            submissionsMarkers = [];
            submissionsMap = null;
        }
        
        // Wait a moment for the modal to be visible before initializing the map
        setTimeout(() => {
            console.log('Starting delayed map initialization');
            
            const mapElement = document.getElementById('submissionsMap');
            if (!mapElement) {
                console.error('Map element not found in DOM');
                return;
            }
            
            console.log('Map element dimensions:', 
                        mapElement.offsetWidth, 'x', 
                        mapElement.offsetHeight, 
                        'Visible:', mapElement.offsetParent !== null);
            
            // Initialize the map if not already done
            if (!submissionsMap) {
                console.log('Initializing submissions map');
                submissionsMap = initializeSubmissionsMap();
                
                if (!submissionsMap) {
                    console.error('Failed to initialize map');
                    return;
                }
            } else {
                console.log('Submissions map already initialized');
            }
            
            // Make sure the map is properly sized (sometimes needed after modal is shown)
            console.log('Triggering map resize');
            google.maps.event.trigger(submissionsMap, 'resize');
            
            // Re-center the map
            const columbiaLocation = {
                lat: 40.8075,
                lng: -73.9626
            };
            submissionsMap.setCenter(columbiaLocation);
            
            // Load submissions and add markers
            console.log('Loading submissions');
            loadSubmissions();
        }, 300); // Longer delay to ensure the modal is fully visible
        
        // Add close button functionality
        if (closeButton) {
            closeButton.onclick = closeSubmissionsModal;
        }
        
        // Add click outside to close functionality
        window.onclick = function(event) {
            if (event.target === modal) {
                closeSubmissionsModal();
            }
        };
        
    } catch (error) {
        console.error('Error opening submissions modal:', error);
    }
}

// Function to close the submissions modal
function closeSubmissionsModal() {
    try {
        const modal = document.getElementById('submissionsModal');
        if (modal) {
            modal.style.display = 'none';
        }
        
        // Clear event handler for modal background
        window.onclick = null;
    } catch (error) {
        console.error('Error closing submissions modal:', error);
    }
}

// Function to initialize the submissions map and heatmap
function initializeSubmissionsMap() {
    try {
        const mapElement = document.getElementById('submissionsMap');
        if (!mapElement) {
            console.error('Submissions map element not found');
            return null;
        }
        
        if (!mapElement.offsetWidth || !mapElement.offsetHeight) {
            console.error('Map element has no size:', 
                         mapElement.offsetWidth, 'x', mapElement.offsetHeight);
            // Set explicit size to ensure map renders
            mapElement.style.width = '100%';
            mapElement.style.height = '500px';
        }
        
        console.log('Found map element, initializing map with dimensions:', 
                   mapElement.offsetWidth, 'x', mapElement.offsetHeight);
        
        // Columbia University coordinates - centered precisely on campus
        const columbiaLocation = {
            lat: 40.8075, 
            lng: -73.9626
        };
        
        // Create the map with light theme styling to match the application's UI
        let map;
        try {
            console.log('Creating new Google Map instance');
            map = new google.maps.Map(mapElement, {
                center: columbiaLocation,
                zoom: 16,  // Closer zoom level for better focus on Columbia
                mapTypeId: google.maps.MapTypeId.ROADMAP,
                mapTypeControl: false, // Remove map type controls for cleaner UI
                streetViewControl: false, // Remove street view control
                // Use the light theme styling defined in window.mapStyles
                styles: window.mapStyles || []
            });
            
            console.log('Map created successfully');
            
            // Add a listener to check when the map is idle (fully loaded)
            google.maps.event.addListenerOnce(map, 'idle', function() {
                console.log('Map is fully loaded and idle');
                
                // Initialize heatmap once the map is loaded
                initializeHeatmap(map);
            });
            
            // Set global variable
            submissionsMap = map;
        } catch (mapError) {
            console.error('Error creating Google Map:', mapError);
            return null;
        }
        
        console.log('Submissions map initialized with light theme');
        
        // Clear any existing markers
        submissionsMarkers.forEach(marker => marker.setMap(null));
        submissionsMarkers = [];
        
        return map;
    } catch (error) {
        console.error('Error initializing submissions map:', error);
        return null;
    }
}

// Function to initialize heatmap
function initializeHeatmap(map) {
    try {
        // Check if visualization library is loaded
        if (!google.maps.visualization) {
            console.warn('Google Maps Visualization library not loaded. Heatmap will not be displayed.');
            return;
        }

        console.log('Initializing heatmap layer');
        
        // Get heatmap data from all submissions
        const heatmapData = [];
        Object.values(submissionClusters).forEach(cluster => {
            // Weight location based on number of submissions
            const weight = Math.min(10, cluster.submissions.length); // Cap weight at 10
            
            // Add weighted point
            heatmapData.push({
                location: new google.maps.LatLng(cluster.location.lat, cluster.location.lng),
                weight: weight
            });
        });
        
        // Create heatmap layer with colors that match the light theme
        const heatmap = new google.maps.visualization.HeatmapLayer({
            data: heatmapData,
            map: map,
            radius: 50, // Size of each heatmap point
            opacity: 0.7,
            gradient: [
                'rgba(0, 0, 0, 0)',
                'rgba(66, 135, 245, 0.5)',  // Lighter blue
                'rgba(56, 135, 245, 0.6)',
                'rgba(46, 115, 229, 0.7)',
                'rgba(36, 95, 209, 0.7)',
                'rgba(26, 75, 189, 0.7)',
                'rgba(16, 55, 169, 0.8)',
                'rgba(6, 35, 149, 0.8)',
                'rgba(11, 10, 128, 0.8)',
                'rgba(54, 6, 102, 0.9)',
                'rgba(92, 5, 90, 0.9)',
                'rgba(123, 4, 67, 0.9)',
                'rgba(165, 2, 32, 0.9)',
                'rgba(204, 0, 0, 0.9)'
            ]
        });
        
        // Store heatmap in a global variable
        window.submissionsHeatmap = heatmap;
        
        console.log('Heatmap initialized with', heatmapData.length, 'weighted points');
    } catch (error) {
        console.error('Error initializing heatmap:', error);
    }
}

// Function to update heatmap data
function updateHeatmapData() {
    try {
        if (!window.submissionsHeatmap || !google.maps.visualization) {
            return;
        }
        
        // Get heatmap data from all submissions
        const heatmapData = [];
        Object.values(submissionClusters).forEach(cluster => {
            // Weight location based on number of submissions
            const weight = Math.min(10, cluster.submissions.length); // Cap weight at 10
            
            // Add weighted point
            heatmapData.push({
                location: new google.maps.LatLng(cluster.location.lat, cluster.location.lng),
                weight: weight
            });
        });
        
        // Update heatmap data
        window.submissionsHeatmap.setData(heatmapData);
        console.log('Updated heatmap with', heatmapData.length, 'weighted points');
    } catch (error) {
        console.error('Error updating heatmap data:', error);
    }
}

// Function to create dummy submissions for testing
function createDummySubmissions() {
    console.log('Dummy submissions disabled');
    
    // Return an empty array instead of creating dummy submissions
    return [];
    
    /* Original dummy data code is commented out
    console.log('Creating dummy submissions for testing');
    
    // Columbia University area coordinates with slight variations
    const baseLocation = { lat: 40.8075, lng: -73.9626 };
    
    // Create dummy submissions with timestamps (for vote tracking)
    const dummyData = [
        {
            imageUrl: 'https://firebasestorage.googleapis.com/v0/b/conflicttoconcensus.appspot.com/o/dummy%2Fclassroom.jpg?alt=media',
            location: { 
                lat: baseLocation.lat + 0.002,
                lng: baseLocation.lng + 0.001
            },
            prompts: {
                mainSubject: 'Modern collaborative classroom',
                context: 'with natural light and flexible seating'
            },
            submittedAt: 'dummy-classroom-1'
        },
        {
            imageUrl: 'https://firebasestorage.googleapis.com/v0/b/conflicttoconcensus.appspot.com/o/dummy%2Fstudy-space.jpg?alt=media',
            location: { 
                lat: baseLocation.lat - 0.001,
                lng: baseLocation.lng + 0.002
            },
            prompts: {
                mainSubject: 'Open plan study space',
                context: 'with private pods and digital resources'
            },
            submittedAt: 'dummy-studyspace-1'
        },
        {
            imageUrl: 'https://firebasestorage.googleapis.com/v0/b/conflicttoconcensus.appspot.com/o/dummy%2Foutdoor.jpg?alt=media',
            location: { 
                lat: baseLocation.lat + 0.001,
                lng: baseLocation.lng - 0.002
            },
            prompts: {
                mainSubject: 'Outdoor learning space',
                context: 'with shade structures and comfortable seating'
            },
            submittedAt: 'dummy-outdoor-1'
        },
        // Add a cluster of submissions at the same location to test clustering
        {
            imageUrl: 'https://firebasestorage.googleapis.com/v0/b/conflicttoconcensus.appspot.com/o/dummy%2Flibrary1.jpg?alt=media',
            location: { 
                lat: baseLocation.lat,
                lng: baseLocation.lng
            },
            prompts: {
                mainSubject: 'Modern library space',
                context: 'with collaborative areas and quiet zones'
            },
            submittedAt: 'dummy-library-1'
        },
        {
            imageUrl: 'https://firebasestorage.googleapis.com/v0/b/conflicttoconcensus.appspot.com/o/dummy%2Flibrary2.jpg?alt=media',
            location: { 
                lat: baseLocation.lat,
                lng: baseLocation.lng
            },
            prompts: {
                mainSubject: 'Library reading room',
                context: 'with comfortable seating and good lighting'
            },
            submittedAt: 'dummy-library-2'
        },
        {
            imageUrl: 'https://firebasestorage.googleapis.com/v0/b/conflicttoconcensus.appspot.com/o/dummy%2Flibrary3.jpg?alt=media',
            location: { 
                lat: baseLocation.lat,
                lng: baseLocation.lng
            },
            prompts: {
                mainSubject: 'Digital media lab',
                context: 'with advanced technology and collaborative workstations'
            },
            submittedAt: 'dummy-library-3'
        }
    ];
    
    console.log('Created', dummyData.length, 'dummy submissions');
    return dummyData;
    */
}

// Make functions available globally
window.openSubmissionsModal = openSubmissionsModal;
window.closeSubmissionsModal = closeSubmissionsModal;

// Function to open the How to Use modal
function openHowToUseModal() {
    try {
        console.log('Opening How to Use modal');
        
        const modal = document.getElementById('howToUseModal');
        if (!modal) {
            console.error('How to Use modal not found');
            return;
        }
        
        // Display the modal
        modal.style.display = 'block';
        
        // Add click outside to close functionality
        window.onclick = function(event) {
            if (event.target === modal) {
                closeHowToUseModal();
            }
        };
        
    } catch (error) {
        console.error('Error opening How to Use modal:', error);
    }
}

// Function to close the How to Use modal
function closeHowToUseModal() {
    try {
        const modal = document.getElementById('howToUseModal');
        if (modal) {
            modal.style.display = 'none';
        }
        
        // Clear event handler for modal background
        window.onclick = null;
    } catch (error) {
        console.error('Error closing How to Use modal:', error);
    }
}

// Make function globally accessible
window.closeHowToUseModal = closeHowToUseModal;

// Add test function for debugging socket issues
function testSocketCommunication() {
    if (socket && socket.connected) {
        console.log('🔍 Testing socket communication... with ID:', socket.id);
        
        // Create a test payload with unique timestamp
        const payload = {
            test_message: `Test from client ${socket.id}`,
            timestamp: Date.now(),
            client_id: socket.id
        };
        
        // Emit a test event
        socket.emit('debug_ping', payload);
        
        // Show visual confirmation
        const testBtn = document.getElementById('socketTestBtn');
        if (testBtn) {
            testBtn.textContent = 'Test Sent ✓';
            setTimeout(() => {
                testBtn.textContent = 'Test Socket';
            }, 2000);
        }
        
        console.log('📤 Test message sent:', payload);
    } else {
        console.error('❌ Cannot test: Socket not connected');
        alert('Socket not connected. Check your network and refresh the page.');
    }
}

// Add a simple test button to the UI
function addSocketTestButton() {
    // Disabled for production - test socket button is only for debugging
    return;
    
    // Don't add if it already exists
    if (document.getElementById('socketTestBtn')) return;
    
    const headerButtons = document.querySelector('.header-buttons');
    if (headerButtons) {
        const testBtn = document.createElement('button');
        testBtn.id = 'socketTestBtn';
        testBtn.className = 'header-button';
        testBtn.textContent = 'Test Socket';
        testBtn.style.backgroundColor = '#FF9800';
        testBtn.addEventListener('click', testSocketCommunication);
        
        // Add at beginning of header buttons
        headerButtons.insertBefore(testBtn, headerButtons.firstChild);
        
        console.log('🔌 Socket test button added to UI');
    }
}

// Add special handler for debug_ping event
function addSocketDebugHandlers() {
    if (!socket) return;
    
    socket.on('debug_ping', (data) => {
        console.log('📥 Received socket test:', data);
        
        // Only show alert if it's from another client
        if (data.user_id && data.user_id !== socket.id && data.client_id !== socket.id) {
            // Flash the connected users button
            const usersBtn = document.getElementById('connectedUsersBtn');
            if (usersBtn) {
                const originalBg = usersBtn.style.backgroundColor;
                usersBtn.style.backgroundColor = '#4CAF50';
                usersBtn.textContent = '🔔 Received!';
                
                setTimeout(() => {
                    usersBtn.style.backgroundColor = originalBg;
                    // Restore original text (showing connected users count)
                    updateUsersList();
                }, 3000);
            }
            
            // Show alert
            alert(`Socket communication working! Received message from user: ${data.user_id}`);
        }
    });
}

// Initialize test features when document is ready
document.addEventListener('DOMContentLoaded', () => {
    // Add socket test button to UI after a delay
    setTimeout(addSocketTestButton, 2000);
    
    // Add debug handlers after socket is initialized
    setTimeout(addSocketDebugHandlers, 3000);
});

// Make functions available globally
window.openHowToUseModal = openHowToUseModal;
window.closeHowToUseModal = closeHowToUseModal;

// Function to generate and download a submissions report
function generateSubmissionsReport() {
    try {
        // Show loading indicator
        const loadingIndicator = document.createElement('div');
        loadingIndicator.style.position = 'fixed';
        loadingIndicator.style.top = '50%';
        loadingIndicator.style.left = '50%';
        loadingIndicator.style.transform = 'translate(-50%, -50%)';
        loadingIndicator.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
        loadingIndicator.style.padding = '20px';
        loadingIndicator.style.borderRadius = '8px';
        loadingIndicator.style.zIndex = '10001';
        loadingIndicator.style.color = 'white';
        loadingIndicator.style.textAlign = 'center';
        loadingIndicator.style.display = 'flex';
        loadingIndicator.style.flexDirection = 'column';
        loadingIndicator.style.alignItems = 'center';
        loadingIndicator.style.gap = '10px';
        
        const loadingText = document.createElement('div');
        loadingText.textContent = 'Generating report...';
        loadingText.style.fontSize = '16px';
        loadingText.style.marginBottom = '10px';
        
        const spinner = document.createElement('div');
        spinner.style.border = '5px solid rgba(255, 255, 255, 0.1)';
        spinner.style.borderTopColor = '#4CAF50';
        spinner.style.borderRadius = '50%';
        spinner.style.width = '40px';
        spinner.style.height = '40px';
        spinner.style.animation = 'spin 1s linear infinite';
        
        // Add a keyframe animation for the spinner
        const style = document.createElement('style');
        style.textContent = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
        document.head.appendChild(style);
        
        loadingIndicator.appendChild(loadingText);
        loadingIndicator.appendChild(spinner);
        document.body.appendChild(loadingIndicator);
        
        // First, try to save all votes to the server (but don't block report generation if it fails)
        fetch('/api/save-votes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ votes: submissionVotes })
        })
        .then(response => {
            if (!response.ok) {
                console.warn('Failed to save votes, but will still generate report');
            }
            return response.ok ? response.json() : null;
        })
        .catch(error => {
            console.warn('Error saving votes, but will still generate report:', error);
        })
        .finally(() => {
            // Regardless of vote saving result, download the report
            window.location.href = '/api/generate-report';
            
            // Remove loading indicator after a short delay to allow download to start
            setTimeout(() => {
                document.body.removeChild(loadingIndicator);
            }, 2000);
        });
    } catch (error) {
        console.error('Error initiating report generation:', error);
        alert('Failed to generate report. Please try again.');
    }
}

// Function to show AI insights in a modal
function showAIInsightsModal(cluster = null) {
    try {
        // Show loading indicator
        const loadingIndicator = document.createElement('div');
        loadingIndicator.style.position = 'fixed';
        loadingIndicator.style.top = '50%';
        loadingIndicator.style.left = '50%';
        loadingIndicator.style.transform = 'translate(-50%, -50%)';
        loadingIndicator.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
        loadingIndicator.style.padding = '20px';
        loadingIndicator.style.borderRadius = '8px';
        loadingIndicator.style.zIndex = '2000002'; // Increased z-index to be above submissions modal
        loadingIndicator.style.color = 'white';
        loadingIndicator.style.textAlign = 'center';
        loadingIndicator.style.display = 'flex';
        loadingIndicator.style.flexDirection = 'column';
        loadingIndicator.style.alignItems = 'center';
        loadingIndicator.style.gap = '10px';
        
        const loadingText = document.createElement('div');
        loadingText.textContent = cluster ? 'Analyzing cluster submissions...' : 'Analyzing all submissions...';
        loadingText.style.fontSize = '16px';
        loadingText.style.marginBottom = '10px';
        
        const spinner = document.createElement('div');
        spinner.style.border = '5px solid rgba(255, 255, 255, 0.1)';
        spinner.style.borderTopColor = '#4CAF50';
        spinner.style.borderRadius = '50%';
        spinner.style.width = '40px';
        spinner.style.height = '40px';
        spinner.style.animation = 'spin 1s linear infinite';
        
        // Add a keyframe animation for the spinner if not already added
        if (!document.querySelector('style#spinner-style')) {
            const style = document.createElement('style');
            style.id = 'spinner-style';
            style.textContent = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
            document.head.appendChild(style);
        }
        
        loadingIndicator.appendChild(loadingText);
        loadingIndicator.appendChild(spinner);
        document.body.appendChild(loadingIndicator);
        
        // Prepare request data
        let url = '/api/analyze-submissions';
        let fetchOptions = { method: 'GET' };
        
        // If we have a specific cluster, send its submissions for analysis
        if (cluster && cluster.submissions && cluster.submissions.length > 0) {
            url = '/api/analyze-custom';
            fetchOptions = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    submissions: cluster.submissions,
                    cluster_location: cluster.location
                })
            };
        }
        
        // Fetch AI analysis
        fetch(url, fetchOptions)
            .then(response => {
                if (!response.ok) {
                    throw new Error('Failed to get AI analysis');
                }
                return response.json();
            })
            .then(data => {
                // Remove loading indicator
                document.body.removeChild(loadingIndicator);
                
                // Create the modal for AI insights
                createAIInsightsModal(data, cluster);
            })
            .catch(error => {
                console.error('Error getting AI insights:', error);
                
                // Update loading indicator to show error
                loadingText.textContent = 'Error analyzing submissions';
                loadingText.style.color = '#e74c3c';
                spinner.style.display = 'none';
                
                // Add error message
                const errorMsg = document.createElement('div');
                errorMsg.textContent = error.message;
                errorMsg.style.color = '#e74c3c';
                errorMsg.style.fontSize = '14px';
                errorMsg.style.marginTop = '10px';
                loadingIndicator.appendChild(errorMsg);
                
                // Add close button to error message
                const closeBtn = document.createElement('button');
                closeBtn.textContent = 'Close';
                closeBtn.style.backgroundColor = '#e74c3c';
                closeBtn.style.color = 'white';
                closeBtn.style.border = 'none';
                closeBtn.style.padding = '8px 16px';
                closeBtn.style.borderRadius = '4px';
                closeBtn.style.cursor = 'pointer';
                closeBtn.style.marginTop = '15px';
                closeBtn.onclick = function() {
                    document.body.removeChild(loadingIndicator);
                };
                loadingIndicator.appendChild(closeBtn);
            });
    } catch (error) {
        console.error('Error showing AI insights modal:', error);
        alert('Failed to show AI insights. Please try again.');
    }
}

// Function to create and display the AI insights modal
function createAIInsightsModal(data, cluster = null) {
    try {
        // Create a modal element
        const modal = document.createElement('div');
        modal.className = 'modal';
        modal.style.display = 'block';
        modal.style.position = 'fixed';
        modal.style.top = '0';
        modal.style.left = '0';
        modal.style.width = '100%';
        modal.style.height = '100%';
        modal.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
        modal.style.backdropFilter = 'blur(5px)';
        modal.style.zIndex = '2000002';
        document.body.appendChild(modal);
        
        // Create modal content similar to How to Use modal
        const modalContent = document.createElement('div');
        modalContent.className = 'modal-content';
        modalContent.style.position = 'relative';
        modalContent.style.width = '90%';
        modalContent.style.maxWidth = '800px';
        modalContent.style.backgroundColor = 'var(--bg-primary)';
        modalContent.style.borderRadius = 'var(--bento-radius)';
        modalContent.style.border = '1px solid var(--glass-border)';
        modalContent.style.boxShadow = 'var(--shadow-lg)';
        modalContent.style.margin = '5% auto';
        modalContent.style.padding = '20px';
        modalContent.style.overflowY = 'auto';
        modalContent.style.maxHeight = '90vh';
        modal.appendChild(modalContent);
        
        // Create modal header
        const modalHeader = document.createElement('div');
        modalHeader.className = 'modal-header';
        modalHeader.style.display = 'flex';
        modalHeader.style.justifyContent = 'space-between';
        modalHeader.style.alignItems = 'center';
        modalHeader.style.borderBottom = '1px solid var(--glass-border)';
        modalHeader.style.paddingBottom = '15px';
        modalHeader.style.marginBottom = '15px';
        modalContent.appendChild(modalHeader);
        
        // Add title to header
        const headerTitle = document.createElement('h2');
        headerTitle.textContent = cluster ? 'AI Analysis of Cluster Submissions' : 'AI Analysis of All Submissions';
        headerTitle.style.margin = '0';
        headerTitle.style.color = 'var(--text-primary)';
        modalHeader.appendChild(headerTitle);
        
        // Add close button to header
        const closeButton = document.createElement('span');
        closeButton.className = 'close-modal';
        closeButton.innerHTML = '&times;';
        closeButton.style.fontSize = '24px';
        closeButton.style.color = 'var(--text-primary)';
        closeButton.style.cursor = 'pointer';
        closeButton.style.transition = 'color 0.2s ease';
        closeButton.onmouseover = function() {
            this.style.color = 'var(--accent-primary)';
        };
        closeButton.onmouseout = function() {
            this.style.color = 'var(--text-primary)';
        };
        closeButton.onclick = function() {
            document.body.removeChild(modal);
        };
        modalHeader.appendChild(closeButton);
        
        // Create modal body
        const modalBody = document.createElement('div');
        modalBody.className = 'modal-body';
        modalBody.style.paddingRight = '10px';
        modalContent.appendChild(modalBody);
        
        // Add submission summary as first instruction step
        const summaryStep = document.createElement('div');
        summaryStep.className = 'instruction-step';
        modalBody.appendChild(summaryStep);
        
        // Add summary header
        const summaryHeader = document.createElement('h3');
        summaryHeader.textContent = 'Summary';
        summaryStep.appendChild(summaryHeader);
        
        // Add summary content container
        const summaryContent = document.createElement('div');
        summaryContent.className = 'step-content';
        summaryStep.appendChild(summaryContent);
        
        // Add submission count and timestamp
        const metaInfo = document.createElement('p');
        
        // If we have cluster data, include location information
        if (cluster && cluster.location) {
            const lat = cluster.location.lat.toFixed(4);
            const lng = cluster.location.lng.toFixed(4);
            metaInfo.textContent = `Analysis of ${data.submission_count} submissions at location (${lat}, ${lng}) • Generated on ${data.generated_at}`;
        } else {
        metaInfo.textContent = `Analysis of ${data.submission_count} submissions • Generated on ${data.generated_at}`;
        }
        
        metaInfo.style.marginBottom = '15px';
        summaryContent.appendChild(metaInfo);
        
        // Parse the AI analysis and create instruction steps for each section
        if (data.analysis && data.analysis.trim()) {
            // Split by double newlines to get paragraphs
            const paragraphs = data.analysis.split('\n\n');
            
            let currentStep = null;
            let currentContent = null;
            
            paragraphs.forEach(paragraph => {
                if (!paragraph.trim()) return;
                
                // Clean up paragraph text - remove any markdown symbols like #, *, etc.
                let cleanText = paragraph.trim()
                    .replace(/^#+\s+/, '') // Remove markdown headings
                    .replace(/^\*\*|\*\*$/g, '') // Remove bold markers
                    .replace(/^\*|\*$/g, '') // Remove italic markers
                    
                // Check if this is a heading (ends with colon or is all caps)
                if (paragraph.trim().endsWith(':') || 
                    (paragraph.trim() === paragraph.trim().toUpperCase() && paragraph.trim().length > 10)) {
                    
                    // Create a new instruction step for this heading
                    currentStep = document.createElement('div');
                    currentStep.className = 'instruction-step';
                    modalBody.appendChild(currentStep);
                    
                    // Add the heading - remove colon if present
                    const heading = document.createElement('h3');
                    heading.textContent = cleanText.replace(/:$/, ''); // Remove trailing colon
                    heading.style.fontWeight = 'bold'; // Make heading bold
                    currentStep.appendChild(heading);
                    
                    // Create content container for this section
                    currentContent = document.createElement('div');
                    currentContent.className = 'step-content';
                    currentStep.appendChild(currentContent);
                    
                } else if (paragraph.includes('\n- ') || paragraph.includes('\n• ')) {
                    // This is a bullet point list
                const parts = paragraph.split('\n');
                    let headerText = parts[0].replace(/^\*\*|\*\*$/g, ''); // Remove bold markers
                const bulletPoints = parts.slice(1);
                
                    // If this is a new section without a proper heading
                    if (!currentStep || bulletPoints.length === 0) {
                        currentStep = document.createElement('div');
                        currentStep.className = 'instruction-step';
                        modalBody.appendChild(currentStep);
                        
                        // Add header if we have one
                        if (headerText && headerText.trim()) {
                            const heading = document.createElement('h3');
                            heading.textContent = headerText.trim().replace(/:$/, ''); // Remove trailing colon
                            heading.style.fontWeight = 'bold'; // Make heading bold
                            currentStep.appendChild(heading);
                        }
                        
                        // Create content container
                        currentContent = document.createElement('div');
                        currentContent.className = 'step-content';
                        currentStep.appendChild(currentContent);
                    } else if (headerText && headerText.trim() && currentContent) {
                        // Add the header text as a paragraph with bold formatting
                        const headerPara = document.createElement('p');
                        headerPara.textContent = headerText.trim().replace(/:$/, ''); // Remove trailing colon
                        headerPara.style.fontWeight = 'bold';
                        headerPara.style.marginTop = '15px';
                        headerPara.style.marginBottom = '5px';
                        currentContent.appendChild(headerPara);
                    }
                    
                    // Create bullet list
                    if (bulletPoints.length > 0 && currentContent) {
                        const bulletList = document.createElement('ul');
                        bulletList.className = 'feature-list';
                        bulletList.style.marginTop = '10px';
                        bulletList.style.paddingLeft = '20px';
                        
                        bulletPoints.forEach(point => {
                            // Clean up bullet point text
                            const cleanedPoint = point
                                .replace(/^[-•*]\s+/, '') // Remove bullet marker
                                .replace(/^\*\*(.+?)\*\*:/, '<strong>$1</strong>:') // Convert markdown bold to HTML
                                .trim();
                            
                            const listItem = document.createElement('li');
                            
                            // Check if this starts with a bold term
                            if (cleanedPoint.startsWith('**') && cleanedPoint.includes('**:')) {
                                // Extract the bold term and its description
                                const boldTermMatch = cleanedPoint.match(/^\*\*(.+?)\*\*:(.*)/);
                                if (boldTermMatch) {
                                    const boldTerm = boldTermMatch[1];
                                    const description = boldTermMatch[2].trim();
                                    
                                    // Create strong element for the bold term
                                    const strong = document.createElement('strong');
                                    strong.textContent = boldTerm + ': ';
                                    listItem.appendChild(strong);
                                    
                                    // Add the description
                                    listItem.appendChild(document.createTextNode(description));
                                } else {
                                    listItem.textContent = cleanedPoint;
                                }
                            } else {
                                // Handle normal HTML content or plain text
                                if (cleanedPoint.includes('<strong>')) {
                                    listItem.innerHTML = cleanedPoint;
                                } else {
                                    listItem.textContent = cleanedPoint;
                                }
                            }
                            
                            listItem.style.marginBottom = '8px';
                            bulletList.appendChild(listItem);
                        });
                        
                        currentContent.appendChild(bulletList);
                    }
                } else {
                    // Regular paragraph
                    
                    // If we don't have a current section, create one
                    if (!currentStep) {
                        currentStep = document.createElement('div');
                        currentStep.className = 'instruction-step';
                        modalBody.appendChild(currentStep);
                        
                        // Create generic heading
                        const heading = document.createElement('h3');
                        heading.textContent = 'Analysis';
                        heading.style.fontWeight = 'bold'; // Make heading bold
                        currentStep.appendChild(heading);
                        
                        // Create content container
                        currentContent = document.createElement('div');
                        currentContent.className = 'step-content';
                        currentStep.appendChild(currentContent);
                    }
                    
                    // Add the paragraph to the current content section
                    if (currentContent) {
                        // Check if paragraph starts with bold text (for subheadings within a section)
                        if (cleanText.startsWith('**') && cleanText.includes('**:')) {
                            const boldMatch = cleanText.match(/^\*\*(.+?)\*\*:(.*)/);
                            if (boldMatch) {
                                const boldText = boldMatch[1];
                                const regularText = boldMatch[2].trim();
                                
                                const para = document.createElement('p');
                                para.style.marginBottom = '10px';
                                
                                const strong = document.createElement('strong');
                                strong.textContent = boldText + ': ';
                                para.appendChild(strong);
                                
                                para.appendChild(document.createTextNode(regularText));
                                currentContent.appendChild(para);
                            } else {
                                const para = document.createElement('p');
                                para.textContent = cleanText;
                                para.style.marginBottom = '10px';
                                currentContent.appendChild(para);
                            }
                        } else {
                            const para = document.createElement('p');
                            para.textContent = cleanText;
                            para.style.marginBottom = '10px';
                            currentContent.appendChild(para);
                        }
                    }
                }
            });
        } else {
            // If no analysis data, show a message
            const noDataStep = document.createElement('div');
            noDataStep.className = 'instruction-step';
            modalBody.appendChild(noDataStep);
            
            const noDataHeader = document.createElement('h3');
            noDataHeader.textContent = 'No Analysis Available';
            noDataStep.appendChild(noDataHeader);
            
            const noDataContent = document.createElement('div');
            noDataContent.className = 'step-content';
            noDataStep.appendChild(noDataContent);
            
            const noDataMessage = document.createElement('p');
            noDataMessage.textContent = 'No analysis data is available for these submissions.';
            noDataContent.appendChild(noDataMessage);
        }
        
        // Add download button section
        const downloadStep = document.createElement('div');
        downloadStep.className = 'instruction-step';
        modalBody.appendChild(downloadStep);
        
        const downloadHeader = document.createElement('h3');
        downloadHeader.textContent = 'Download Full Report';
        downloadStep.appendChild(downloadHeader);
        
        const downloadContent = document.createElement('div');
        downloadContent.className = 'step-content';
        downloadContent.style.textAlign = 'center';
        downloadStep.appendChild(downloadContent);
        
        // Add download tip
        const downloadTip = document.createElement('p');
        downloadTip.className = 'tip';
        downloadTip.innerHTML = '💡 Get a comprehensive PDF report with visualizations and detailed analysis:';
        downloadTip.style.marginBottom = '15px';
        downloadContent.appendChild(downloadTip);
        
        // Add download button
        const downloadButton = document.createElement('button');
        downloadButton.textContent = 'Download Full PDF Report';
        downloadButton.style.backgroundColor = 'var(--accent-primary)';
        downloadButton.style.color = 'white';
        downloadButton.style.border = 'none';
        downloadButton.style.padding = '10px 20px';
        downloadButton.style.borderRadius = '8px';
        downloadButton.style.cursor = 'pointer';
        downloadButton.style.fontSize = '16px';
        downloadButton.style.fontWeight = '500';
        downloadButton.style.display = 'inline-block';
        downloadButton.style.transition = 'all 0.2s ease';
        
        downloadButton.onmouseover = function() {
            this.style.backgroundColor = 'var(--accent-secondary)';
            this.style.transform = 'translateY(-2px)';
            this.style.boxShadow = 'var(--shadow-md)';
        };
        
        downloadButton.onmouseout = function() {
            this.style.backgroundColor = 'var(--accent-primary)';
            this.style.transform = 'translateY(0)';
            this.style.boxShadow = 'none';
        };
        
        downloadButton.onclick = function() {
            // Use a direct approach instead of going through generateSubmissionsReport
            // If we have cluster data, pass that to the report endpoint
            if (cluster && cluster.submissions && cluster.submissions.length > 0) {
                // Create a form for POST submission
                const form = document.createElement('form');
                form.method = 'POST';
                form.action = '/api/generate-cluster-report';
                form.target = '_blank';
                form.style.display = 'none';
                
                // Add cluster data as input
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = 'cluster_data';
                input.value = JSON.stringify({
                    submissions: cluster.submissions,
                    location: cluster.location
                });
                form.appendChild(input);
                
                // Submit the form
                document.body.appendChild(form);
                form.submit();
                document.body.removeChild(form);
            } else {
                // Use the standard report endpoint for all submissions
            window.open('/api/generate-report', '_blank');
            }
        };
        downloadContent.appendChild(downloadButton);
        
        // Add a final tip
        const finalTip = document.createElement('p');
        finalTip.className = 'final-tip';
        finalTip.textContent = 'The PDF report includes additional visualizations, statistics, and detailed insights.';
        finalTip.style.marginTop = '15px';
        finalTip.style.fontSize = '14px';
        finalTip.style.color = 'var(--text-secondary)';
        finalTip.style.fontStyle = 'italic';
        downloadContent.appendChild(finalTip);
        
        // Close modal when clicking outside
        modal.addEventListener('click', function(event) {
            if (event.target === modal) {
                document.body.removeChild(modal);
            }
        });
        
    } catch (error) {
        console.error('Error creating AI insights modal:', error);
        alert('Failed to display AI insights. Please try again.');
    }
}

// Update the clear mask function
function clearMask() {
    if (!maskCanvas || !maskCtx) return;
    
    // Clear the local mask
    maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
    
    // Emit clear event to other users
    if (socket && socket.connected) {
        socket.emit('clear_mask');
    }
}

// Update the clear button event listener
const clearBtn = document.getElementById('clear-btn');
if (clearBtn) {
    clearBtn.addEventListener('click', clearMask);
}

