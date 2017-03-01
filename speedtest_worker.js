/*
	HTML5 Speedtest v4.0
	by Federico Dossena
	https://github.com/adolfintel/speedtest/
	GNU LGPLv3 License
*/

var testStatus=0, //0=not started, 1=download test, 2=ping+jitter test, 3=upload test, 4=finished, 5=abort/error
	dlStatus="", //download speed in megabit/s with 2 decimal digits
	ulStatus="", //upload speed in megabit/s with 2 decimal digits
	pingStatus="", //ping in milliseconds with 2 decimal digits
	jitterStatus="", //jitter in milliseconds with 2 decimal digits
	clientIp=""; //client's IP address as reported by getIP.php

var settings={ //test settings. can be overridden by sending specific values with the start command
	time_ul:15, //duration of upload test in seconds (>10 recommended)
	time_dl:15, //duration of download test in seconds (>5 recommended)
	count_ping:35, //number of pings to perform in upload test (>20 recommended)
	url_dl:"garbage.php", //path to a large file or garbage.php, used for download test. must be relative to this js file
	url_ul:"empty.dat", //path to an empty file, used for upload test. must be relative to this js file
	url_ping:"empty.dat", //path to an empty file, used for ping test. must be relative to this js file
	url_getIp:"getIP.php", //path to getIP.php relative to this js file, or a similar thing that outputs the client's ip
	xhr_dlMultistream:10, //number of download streams to use (can be different if enable_quirks is active) (>2 recommended)
	xhr_ulMultistream:3, //number of upload streams to use (can be different if enable_quirks is active) (>1 recommended)
	garbagePhp_chunkSize:20, //size of chunks sent by garbage.php (can be different if enable_quirks is active)
	enable_quirks:true, //enable quirks for specific browsers. currently it overrides settings to optimize for specific browsers, unless they are already being overridden with the start command
	allow_fetchAPI:false //enables Fetch API. currently disabled because it leaks memory like no tomorrow
	};

var xhr=null, //array of currently active xhr requests
	interval=null; //timer used in tests
	
var useFetchAPI=false; //when set to true (automatically) the download test will use the fetch api instead of xhr
	
/*
	listener for commands from main thread to this worker.
	commands:
	-status: returns the current status as a string of values spearated by a semicolon (;) in this order: testStatus;dlStatus;ulStatus;pingStatus;clientIp;jitterStatus
	-abort: aborts the current test
	-start: starts the test. optionally, settings can be passed as JSON. 
		example: start start {"time_ul":"10", "time_dl":"10", "count_ping":"50"}
*/
this.addEventListener('message', function(e){
	var params=e.data.split(" ");
	if(params[0]=="status"){ //return status
		postMessage(testStatus+";"+dlStatus+";"+ulStatus+";"+pingStatus+";"+clientIp+";"+jitterStatus);
	}
	if(params[0]=="start"&&testStatus==0){ //start new test
		testStatus=1;
		try{
			//parse settings, if present
			var s=JSON.parse(e.data.substring(5));
			if(typeof s.url_dl != "undefined") settings.url_dl=s.url_dl; //download url
			if(typeof s.url_ul != "undefined") settings.url_ul=s.url_ul; //upload url
			if(typeof s.url_ping != "undefined") settings.url_ping=s.url_ping; //ping url
			if(typeof s.url_getIp != "undefined") settings.url_getIp=s.url_getIp; //url to getIP.php
			if(typeof s.time_dl != "undefined") settings.time_dl=s.time_dl; //duration of download test
			if(typeof s.time_ul != "undefined") settings.time_ul=s.time_ul; //duration of upload test
			if(typeof s.enable_quirks != "undefined") settings.enable_quirks=s.enable_quirks; //enable quirks or not
			//quirks for specific browsers. more may be added in future releases
			if(settings.enable_quirks){
				var ua=navigator.userAgent;
				if(/Firefox.(\d+\.\d+)/i.test(ua)){
					//ff more precise with 1 upload stream
					settings.xhr_ulMultistream=1;
				}
				if(/Edge.(\d+\.\d+)/i.test(ua)){
					//edge more precise with 3 download streams
					settings.xhr_dlMultistream=3;
				}
				if((/Safari.(\d+)/i.test(ua))&&!(/Chrome.(\d+)/i.test(ua))){
					//safari is the usual shit
					settings.xhr_dlMultistream=1;
					settings.xhr_ulMultistream=1;
				}
				if(/Chrome.(\d+)/i.test(ua)&&(!!self.fetch)){
					//chrome can't handle large xhr very well, use fetch api if available and allowed
					if(settings.allow_fetchAPI) useFetchAPI=true;
					//also, smaller chunks seem to be better here
					settings.garbagePhp_chunkSize=10;
				}
			}
			if(typeof s.count_ping != "undefined") settings.count_ping=s.count_ping; //number of pings for ping test
			if(typeof s.xhr_dlMultistream != "undefined") settings.xhr_dlMultistream=s.xhr_dlMultistream; //number of download streams
			if(typeof s.xhr_ulMultistream != "undefined") settings.xhr_ulMultistream=s.xhr_ulMultistream; //number of upload streams
			if(typeof s.garbagePhp_chunkSize != "undefined") settings.garbagePhp_chunkSize=s.garbagePhp_chunkSize; //size of garbage.php chunks
			if(typeof s.allow_fetchAPI != "undefined") settings.allow_fetchAPI=s.allow_fetchAPI; //allows fetch api to be used if supported
			if(settings.allow_fetchAPI&&(!!self.fetch)) useFetchAPI=true;
		}catch(e){console.log(e)}
		//run the tests
		console.log(settings);
		getIp(function(){dlTest(function(){testStatus=2;pingTest(function(){testStatus=3;ulTest(function(){testStatus=4;});});})});
	}
	if(params[0]=="abort"){ //abort command
		clearRequests(); //stop all xhr activity
		if(interval)clearInterval(interval); //clear timer if present
		testStatus=5;dlStatus="";ulStatus="";pingStatus="";jitterStatus=""; //set test as aborted
	}
});
//stops all XHR activity, aggressively
function clearRequests(){
	if(xhr){
		for(var i=0;i<xhr.length;i++){
			if(useFetchAPI)try{xhr[i].cancelRequested=true;}catch(e){}
			try{xhr[i].onprogress=null; xhr[i].onload=null; xhr[i].onerror=null;}catch(e){}
			try{xhr[i].upload.onprogress=null; xhr[i].upload.onload=null; xhr[i].upload.onerror=null;}catch(e){}
			try{xhr[i].abort();}catch(e){}
		}
		xhr=null;
	}
}
//gets client's IP using url_getIp, then calls the done function
function getIp(done){
	xhr=new XMLHttpRequest();
	xhr.onload=function(){
		clientIp=xhr.responseText;
		done();
	}
	xhr.onerror=function(){
		done();
	}
	xhr.open("GET",settings.url_getIp+"?r="+Math.random(),true);
	xhr.send();
}
//download test, calls done function when it's over
var dlCalled=false; //used to prevent multiple accidental calls to dlTest
function dlTest(done){
	if(dlCalled) return; else dlCalled=true; //dlTest already called?
	var totLoaded=0.0, //total number of loaded bytes
		startT=new Date().getTime(); //timestamp when test was started
	xhr=[]; 
	//function to create a download stream
	var testStream=function(i){
		setTimeout(function(){ //delay creation of a stream slightly so that the new stream is completely detached from the one that created it
			if(useFetchAPI){
				xhr[i]=fetch(settings.url_dl+"?r="+Math.random()+"&ckSize="+settings.garbagePhp_chunkSize).then(function(response) {
				  var reader = response.body.getReader();
				  var consume=function() {
					return reader.read().then(function(result){
						if(result.done) testStream(i); else{
							totLoaded+=result.value.length;
							if(xhr[i].canelRequested) reader.cancel();
						}
					  return consume();
					}.bind(this));
				  }.bind(this);
				  return consume();
				}.bind(this));
			}else{
				var prevLoaded=0; //number of bytes loaded last time onprogress was called
				xhr[i]=new XMLHttpRequest();
				xhr[i].onprogress=function(event){
					//progress event, add number of new loaded bytes to totLoaded
					var loadDiff=event.loaded<=0?0:(event.loaded-prevLoaded);
					if(isNaN(loadDiff)||!isFinite(loadDiff)||loadDiff<0) return; //just in case
					totLoaded+=loadDiff;
					prevLoaded=event.loaded;
				}.bind(this);
				xhr[i].onload=function(){
					//the large file has been loaded entirely, start again
					testStream(i);
				}.bind(this);
				xhr[i].onerror=function(){
					//error, abort stream and ignore
					try{xhr[i].abort();}catch(e){}
					xhr[i]=null;
				}.bind(this);
				//send xhr
				xhr[i].open("GET",settings.url_dl+"?r="+Math.random()+"&ckSize="+settings.garbagePhp_chunkSize,true); //random string to prevent caching
				xhr[i].send();
			}
		}.bind(this),1);
	}.bind(this);
	//open streams
	for(var i=0;i<settings.xhr_dlMultistream;i++){
		testStream(i);
	}
	//every 200ms, update dlStatus
	interval=setInterval(function(){
		var t=new Date().getTime()-startT;
		if(t<200) return;
		var speed=totLoaded/(t/1000.0);
		dlStatus=((speed*8)/925000.0).toFixed(2); //925000 instead of 1048576 to account for overhead
		if((t/1000.0)>settings.time_dl){ //test is over, stop streams and timer
			clearRequests();
			clearInterval(interval);
			done();
		}
	}.bind(this),200);
}
//upload test, calls done function whent it's over
//garbage data for upload test (1mb of random bytes repeated 20 times, for a total of 20mb)
var r=new ArrayBuffer(1048576);
try{r=new Float32Array(r);for(var i=0;i<r.length;i++)r[i]=Math.random();}catch(e){}
var req=[];
for(var i=0;i<20;i++) req.push(r);
req=new Blob(req);
var ulCalled=false; //used to prevent multiple accidental calls to ulTest
function ulTest(done){
	if(ulCalled) return; else ulCalled=true; //ulTest already called?
	var totLoaded=0.0, //total number of transmitted bytes
		startT=new Date().getTime(); //timestamp when test was started
	xhr=[];
	//function to create an upload stream
	var testStream=function(i){
		setTimeout(function(){ //delay creation of a stream slightly so that the new stream is completely detached from the one that created it
			var prevLoaded=0; //number of bytes transmitted last time onprogress was called
			xhr[i]=new XMLHttpRequest();
			xhr[i].upload.onprogress=function(event){
				//progress event, add number of new loaded bytes to totLoaded
				var loadDiff=event.loaded<=0?0:(event.loaded-prevLoaded);
				if(isNaN(loadDiff)||!isFinite(loadDiff)||loadDiff<0) return; //just in case
				totLoaded+=loadDiff;
				prevLoaded=event.loaded;
			}.bind(this);
			xhr[i].upload.onload=function(){
				//this stream sent all 20mb of garbage data, start again
				testStream(i);
			}.bind(this);
			xhr[i].upload.onerror=function(){
				//error, abort stream and ignore
				try{xhr[i].abort();}catch(e){}
				xhr[i]=null;
			}.bind(this);
			//send xhr
			xhr[i].open("POST",settings.url_ul+"?r="+Math.random(),true); //random string to prevent caching
			xhr[i].setRequestHeader('Content-Encoding','identity'); //disable compression (some browsers may refuse it, but data is incompressible anyway)
			xhr[i].send(req);
		}.bind(this),1);
	}.bind(this);
	//open streams
	for(var i=0;i<settings.xhr_ulMultistream;i++){
		testStream(i);
	}
	//every 200ms, update ulStatus
	interval=setInterval(function(){
		var t=new Date().getTime()-startT;
		if(t<200) return;
		var speed=totLoaded/(t/1000.0);
		ulStatus=((speed*8)/925000.0).toFixed(2); //925000 instead of 1048576 to account for overhead
		if((t/1000.0)>settings.time_ul){ //test is over, stop streams and timer
			clearRequests();
			clearInterval(interval);
			done();
		}
	}.bind(this),200);
}
//ping+jitter test, function done is called when it's over
var ptCalled=false; //used to prevent multiple accidental calls to pingTest
function pingTest(done){
	if(ptCalled) return; else ptCalled=true; //pingTest already called?
    var prevT=null, //last time a pong was received
		ping=0.0, //current ping value
		jitter=0.0, //current jitter value
		i=0, //counter of pongs received
		prevInstspd=0; //last ping time, used for jitter calculation
	xhr=[];
	//ping function
    var doPing=function(){
        prevT=new Date().getTime();
        xhr[0]=new XMLHttpRequest();
        xhr[0].onload=function(){
			//pong
            if(i==0){
                prevT=new Date().getTime(); //first pong
            }else{
                var instspd=(new Date().getTime()-prevT)/2;
				var instjitter=Math.abs(instspd-prevInstspd);
                if(i==1)ping=instspd; /*first ping, can't tell jiutter yet*/ else{
					ping=ping*0.9+instspd*0.1; //ping, weighted average
					jitter=instjitter>jitter?(jitter*0.2+instjitter*0.8):(jitter*0.9+instjitter*0.1); //update jitter, weighted average. spikes in ping values are given more weight.
				}
				prevInstspd=instspd;
            }
            pingStatus=ping.toFixed(2);
			jitterStatus=jitter.toFixed(2);
            i++;
            if(i<settings.count_ping) doPing(); else done(); //more pings to do?
        }.bind(this);
        xhr[0].onerror=function(){
			//a ping failed, cancel ping test
            pingStatus="Fail";
            done();
        }.bind(this);
		//sent xhr
        xhr[0].open("GET",settings.url_ping+"?r="+Math.random(),true); //random string to prevent caching
        xhr[0].send();
    }.bind(this);
    doPing(); //start first ping
}
