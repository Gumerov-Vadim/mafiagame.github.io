import {useEffect, useRef, useCallback, useState} from 'react';
import freeice from 'freeice';
import useStateWithCallback from './useStateWithCallback';
import socket from '../socket';
import ACTIONS from '../socket/actions';

import { useAuth } from '../contexts/AuthContext';
import { db } from '../firebase';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { activate } from 'firebase/remote-config';

export const LOCAL_VIDEO = 'LOCAL_VIDEO';


export default function useWebRTC(roomID) {
  //Все доступные клиенты
  const [clients, updateClients] = useStateWithCallback([]);
  const [isModerator, setIsModerator] = useState(false);
  const addNewClient = useCallback((newClient, cb) => {
    updateClients(list => {
      if (!list.includes(newClient)) {
        return [...list, newClient]
      }
      return list;
    }, cb);
  }, [updateClients]);

  //Соединения с другими пользователями
  const peerConnections = useRef({});
  //Ссылка на свой видеоэлемент, который транслируется с вебкамеры
  const localMediaStream = useRef(null);
  //Ссылка на все видеоэлементы на странице
  const peerMediaElements = useRef({
    [LOCAL_VIDEO]: null,
  });

  const playersInfo = useRef({});
  const { user } = useAuth();
  const [userData, setUserData] = useState(null);
  useEffect(() => {
    const fetchUserData = async () => {
        if (user) {
            const docRef = doc(db, 'user', user.uid);
            const docSnap = await getDoc(docRef);

            if (docSnap.exists()) {
                const data = docSnap.data();
                setUserData(data);
            }
        }
    };

    try {
        fetchUserData();
      } catch (e) {
        console.log(`error fetch user data: ${e}`);
    }
}, [user]);
  useEffect(()=>{
    if(userData){
      socket.emit(ACTIONS.CLIENT_INFO,
        {
          peerid:socket.id,
          userData,
        }); 
    }
  },userData)


  // useEffect(()=>{
  //   socket.on(ACTIONS.TEST, ({clients,roomID}) =>{
  //     console.log(`usewebrtc action test: \nclients ${clients}\nroomID ${roomID}`);
  //   })
  // })


  useEffect(() => {
    //Функция добавления нового пира при ADD_PEER
    async function handleNewPeer({peerID, createOffer}) {
      if (peerID in peerConnections.current) {
        return console.warn(`Already connected to peer ${peerID}`);
      }

      //Создание объекта RTCPeerConnetion
      peerConnections.current[peerID] = new RTCPeerConnection({
        iceServers: freeice(), //предоставляем набор адресов ice серверов
      });

      //Новый кандидат желает подключится, отправляем другим клиентам. Срабатывает после setLocalDescription
      peerConnections.current[peerID].onicecandidate = event => {
        if (event.candidate) {
          socket.emit(ACTIONS.RELAY_ICE, {
            peerID,
            iceCandidate: event.candidate,
          });
        }
      }

      let tracksNumber = 0;
      //При получении нового трека извлекаем стримы (remoteStream)
      peerConnections.current[peerID].ontrack = ({streams: [remoteStream]}) => {
        tracksNumber++

        if (tracksNumber === 2) { // video & audio tracks received
          tracksNumber = 0;
          //Добавляем нового клиента, рендерим 
          addNewClient(peerID, () => {
            if (peerMediaElements.current[peerID]) {
              //Транслируем в видеоэлементе, который создался для PeerID remoteStream.
              peerMediaElements.current[peerID].srcObject = remoteStream;
            } else {
              // FIX LONG RENDER IN CASE OF MANY CLIENTS
              let settled = false;
              const interval = setInterval(() => {
                if (peerMediaElements.current[peerID]) {
                  peerMediaElements.current[peerID].srcObject = remoteStream;
                  settled = true;
                }

                if (settled) {
                  clearInterval(interval);
                }
              }, 1000);
            }
          });
        }
      }

      //Добавляем к peerConnetion наши localMediaStream треки.
      localMediaStream.current.getTracks().forEach(track => {
        peerConnections.current[peerID].addTrack(track, localMediaStream.current);
      });
      //Создание оффера
      if (createOffer) {
        const offer = await peerConnections.current[peerID].createOffer();

        //После этого срабатывает eventListener onicecandidate
        await peerConnections.current[peerID].setLocalDescription(offer);

        socket.emit(ACTIONS.RELAY_SDP, {
          peerID,
          sessionDescription: offer,
        });
      }
    }

    socket.on(ACTIONS.ADD_PEER, handleNewPeer);

    return () => {
      socket.off(ACTIONS.ADD_PEER);
    }
  }, [addNewClient]);

  useEffect(() => {
    
    //Функция для обработки remote description
    async function setRemoteMedia({peerID, sessionDescription: remoteDescription}) {
      await peerConnections.current[peerID]?.setRemoteDescription(
        new RTCSessionDescription(remoteDescription)
      );

      //Если получили предложение, то создаём ответ
      if (remoteDescription.type === 'offer') {
        const answer = await peerConnections.current[peerID].createAnswer();

        await peerConnections.current[peerID].setLocalDescription(answer);
        //Отправляем ответ
        socket.emit(ACTIONS.RELAY_SDP, {
          peerID,
          sessionDescription: answer,
        });
      }
    }

    //Реагирование на получение remote description
    socket.on(ACTIONS.SESSION_DESCRIPTION, setRemoteMedia)

    return () => {
      socket.off(ACTIONS.SESSION_DESCRIPTION);
    }
  }, []);

  useEffect(() => {
    //Реагирование на получение ICE CANDIDATE
    socket.on(ACTIONS.ICE_CANDIDATE, ({peerID, iceCandidate}) => {
      peerConnections.current[peerID]?.addIceCandidate(
        new RTCIceCandidate(iceCandidate)
      );
    });

    return () => {
      socket.off(ACTIONS.ICE_CANDIDATE);
    }
  }, []);

  useEffect(() => {
    const handleRemovePeer = ({peerID}) => {
      if (peerConnections.current[peerID]) {
        peerConnections.current[peerID].close();
      }

      delete peerConnections.current[peerID];
      delete peerMediaElements.current[peerID];

      updateClients(list => list.filter(c => c !== peerID));
    };
    //При удалении соединения
    socket.on(ACTIONS.REMOVE_PEER, handleRemovePeer);

    return () => {
      socket.off(ACTIONS.REMOVE_PEER);
    }
  }, [updateClients]);

  //UseEffect в котором захватывается медиа и добавляется в localMediaStream, после этого вызывается socket JOIN
  useEffect(() => {
    //Функция захвата видео с камеры
    async function startCapture() {
      try{
      localMediaStream.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: {
          width: 800,
          height: 600,
          // width: 1280,
          // height: 720,
        }
        // video:false
      });

      
      addNewClient(LOCAL_VIDEO, () => {
        const localVideoElement = peerMediaElements.current[LOCAL_VIDEO];

        if (localVideoElement) {
          localVideoElement.volume = 0;
          localVideoElement.srcObject = localMediaStream.current;
        }
      });
    } catch (error) {
      console.error('Ошибка при получении мультимедиа:', error);
    }
      
    }
    startCapture()
      .then(() => socket.emit(ACTIONS.JOIN, {room: roomID}))
      .catch(e => console.error('Error getting userMedia:', e));

    return () => {
      if (localMediaStream.current) {
      localMediaStream.current.getTracks().forEach(track => track.stop());
    }
      socket.emit(ACTIONS.LEAVE);
    };
  }, [addNewClient,roomID]);

  
  
  const [isCamAllowed,setIsCamAllowed] = useState(true);
  const [isMicAllowed,setIsMicAllowed] = useState(true);
  const [isCamEnabled,setIsCamEnabled] = useState(true);
  const [isMicEnabled,setIsMicEnabled] = useState(true);
  const [isCamPermitted,setIsCamPermitted] = useState(true);
  const [isMicPermitted,setIsMicPermitted] = useState(true);
  const [isRejected,setIsRejected] = useState('');

  // Добавляем useEffect для обработки включения/выключения камеры/микрофона
    const disableMyCamToAll = () =>{
      const videoTrack = localMediaStream.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = false;
        Object.keys(peerConnections.current).forEach(peerID => {
          const peerConnection = peerConnections.current[peerID];
          const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
          if (sender) {
            sender.replaceTrack(videoTrack);
          }
        });
      }
    }
    const  disableMyMicToAll = () =>{
      const audioTrack = localMediaStream.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = false;
        Object.keys(peerConnections.current).forEach(peerID => {
          const peerConnection = peerConnections.current[peerID];
          const sender = peerConnection.getSenders().find(s => s.track.kind === 'audio');
          if (sender) {
            sender.replaceTrack(audioTrack);
          }
        });
      }
    }

    const enableMyCamToAll = () =>{
      const videoTrack = localMediaStream.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = true;
        Object.keys(peerConnections.current).forEach(peerID => {
          const peerConnection = peerConnections.current[peerID];
          const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
          if (sender) {
            sender.replaceTrack(videoTrack);
          }
        });
      }
    }
    const enableMyMicToAll = () =>{
      const audioTrack = localMediaStream.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = true;
        Object.keys(peerConnections.current).forEach(peerID => {
          const peerConnection = peerConnections.current[peerID];
          const sender = peerConnection.getSenders().find(s => s.track.kind === 'audio');
          if (sender) {
            sender.replaceTrack(audioTrack);
          }
        });
      }
    }

    const disableMyCamToSingle = (peerID) =>{
      const videoTrack = localMediaStream.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = false;
          const peerConnection = peerConnections.current[peerID];
          const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
          if (sender) {
            sender.replaceTrack(videoTrack);
          }
      }
    }
    const  disableMyMicToSingle = (peerID) =>{
      const audioTrack = localMediaStream.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = false;
          const peerConnection = peerConnections.current[peerID];
          const sender = peerConnection.getSenders().find(s => s.track.kind === 'audio');
          if (sender) {
            sender.replaceTrack(audioTrack);
          }
      }
    }

    const enableMyCamToSingle = (peerID) =>{
      const videoTrack = localMediaStream.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = true;
          const peerConnection = peerConnections.current[peerID];
          const sender = peerConnection.getSenders().find(s => s.track.kind === 'video');
          if (sender) {
            sender.replaceTrack(videoTrack);
          }
      }
    }
    const enableMyMicToSingle = (peerID) =>{
      const audioTrack = localMediaStream.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = true;
          const peerConnection = peerConnections.current[peerID];
          const sender = peerConnection.getSenders().find(s => s.track.kind === 'audio');
          if (sender) {
            sender.replaceTrack(audioTrack);
          }
      }      
    }

    
  const moderatorChangedMicAllow = useCallback(()=>{
    if(isMicAllowed){
      disableMyMicToAll();
      setIsMicEnabled(false);
    }
    setIsMicAllowed(prev=>!prev);    
  },[isMicAllowed]);
  
  const moderatorChangedCamAllow = useCallback(()=>{
    if(isCamAllowed){
      disableMyCamToAll();
      setIsCamEnabled(false);
    }
    setIsCamAllowed(prev=>!prev);    
  },[isCamAllowed]);

  useEffect(() => {
    socket.on(ACTIONS.SET_MODERATOR, ({ isModerator }) => {
      setIsModerator(isModerator);
    });

    socket.on(ACTIONS.MODERATOR_ACTION, ({ action }) => {
      // Handle actions for toggling mic, camera, etc.
      console.log(`Action from moderator: ${action}`);
      if(action===ACTIONS.MA.CHANGE_PLAYER_CAM_ALLOW){
        moderatorChangedCamAllow()
      }
      if(action===ACTIONS.MA.CHANGE_PLAYER_MIC_ALLOW){
        moderatorChangedMicAllow();
      }
    });

    return () => {
      socket.off(ACTIONS.SET_MODERATOR);
      socket.off(ACTIONS.MODERATOR_ACTION);
    };
  }, []);
  
  useEffect(()=>{
    socket.on(ACTIONS.KICK,(reason)=>{
      setIsRejected(reason);
      if (localMediaStream.current) {
      localMediaStream.current.getTracks().forEach(track => track.stop());
    }
      socket.emit(ACTIONS.LEAVE);
    });
  });

  const MAtoggleMic = useCallback((peerID)=>{
    socket.emit(ACTIONS.MODERATOR_ACTION, {targetClientID:peerID,action: ACTIONS.MA.CHANGE_PLAYER_MIC_ALLOW} )
},[])

  const MAtoggleCam = useCallback((peerID)=>{
    socket.emit(ACTIONS.MODERATOR_ACTION, {targetClientID:peerID,action: ACTIONS.MA.CHANGE_PLAYER_CAM_ALLOW} )
  },[])

  const handlePause = useCallback(()=>{
    socket.emit(ACTIONS.MODERATOR_ACTION, {targetClientID:'all',action: ACTIONS.MA.PAUSE_GAME} )
  },[])
  const handleContinue = useCallback(()=>{
    socket.emit(ACTIONS.MODERATOR_ACTION, {targetClientID:'all',action: ACTIONS.MA.RESUME_GAME} )
  },[])
  const handleStart = useCallback(()=>{
    socket.emit(ACTIONS.MODERATOR_ACTION, {targetClientID:'all',action: ACTIONS.MA.START_GAME} )
  },[])
  const handleRestart = useCallback(()=>{
    socket.emit(ACTIONS.MODERATOR_ACTION, {targetClientID:'all',action: ACTIONS.MA.RESTART_GAME} )
  },[])
  const handleEndGame = useCallback(()=>{
    socket.emit(ACTIONS.MODERATOR_ACTION, {targetClientID:'all',action: ACTIONS.MA.FINISH_GAME} )
  },[])

  const toggleMic = useCallback(()=>{
    if(!isMicEnabled&&isMicAllowed&&isMicPermitted){
      enableMyMicToAll()
    }
    isMicEnabled&&disableMyMicToAll();
    setIsMicEnabled(prev=>!prev);    
  },[isMicEnabled,isMicAllowed,isMicPermitted]);
  
  const toggleCam = useCallback(()=>{
    if(!isCamEnabled&&isCamAllowed&&isCamPermitted){
      enableMyCamToAll();
    }
    isCamEnabled&&disableMyCamToAll();
    setIsCamEnabled(prev=>!prev);    
  },[isCamEnabled,isCamAllowed,isCamPermitted]);


  const provideMediaRef = useCallback((id, node) => {
    peerMediaElements.current[id] = node;
  }, [peerMediaElements]);

  //test
  return {
    clients,
    provideMediaRef,
    toggleMic,toggleCam,
    MAtoggleMic,MAtoggleCam,
    handlePause,handleContinue,handleRestart,handleEndGame,handleStart,
    isModerator,
    isCamAllowed,
    isMicAllowed,
    isCamEnabled,
    isMicEnabled,
    isRejected,
  };

}
